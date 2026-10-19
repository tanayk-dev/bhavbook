// The import service: preview (writes nothing, returns a 15-minute single-use token) and commit (pre-import backup,
// one transaction, then the recompute hook). Previews live in memory only, so their number and size are bounded.
import { randomBytes } from 'node:crypto';
import { dhanAdapter, zerodhaAdapter, type BrokerAdapter, type ParseResult } from '@bhavbook/adapters';
import type Database from 'better-sqlite3';
import type { IssueForecast } from '../recompute/index.js';
import { autoBackup } from '../vault/index.js';
import { writeBatches, type CommittedBatch } from './commit.js';
import { accountCoverage, type KindCoverage } from './coverage.js';
import { ImportError } from './errors.js';
import { previewFile, type FilePreview, type ImportFile, type ParsedFile, type SeenKeys } from './preview.js';
import { MAX_IMPORT_BYTES } from './read.js';
import { removeBatch, type UndoResult } from './undo.js';

export const PREVIEW_TTL_MS = 15 * 60 * 1000;
/** Previews kept at once; the oldest is dropped first (each holds parsed files in memory). */
export const MAX_PENDING_PREVIEWS = 8;
/** Files per preview, and their total size: bounds the memory one preview can hold. */
export const MAX_PREVIEW_FILES = 10;
export const MAX_PREVIEW_BYTES = 4 * MAX_IMPORT_BYTES;
/** File names are echoed back in the preview (never stored); long ones are cut. */
export const MAX_LABEL_CHARS = 255;

export const DEFAULT_ADAPTERS: readonly BrokerAdapter[] = [zerodhaAdapter, dhanAdapter];

export interface ImportServiceOptions {
  readonly db: Database.Database;
  readonly vaultPath: string;
  readonly appVersion: string;
  readonly now?: () => Date;
  /** Called after every change to an account's rows; the recompute trigger (a no-op until S9). Must not throw. */
  readonly onChanged?: (accountId: string) => void;
  readonly adapters?: readonly BrokerAdapter[];
  /** The preview's issue forecast (dry-run recompute, S9); none by default. */
  readonly forecast?: (accountId: string, result: ParseResult) => readonly IssueForecast[];
}

export interface ImportPreview {
  /** Null when no file can be committed. */
  readonly token: string | null;
  readonly expiresAt: string;
  readonly files: readonly FilePreview[];
}

export interface CommitResult {
  readonly batches: readonly CommittedBatch[];
}

export interface ImportService {
  previewImport(accountId: string, files: readonly ImportFile[]): Promise<ImportPreview>;
  commitImport(token: string): CommitResult;
  /** Removes one committed batch (pre-undo backup, one transaction, then the recompute hook). */
  undoImport(batchId: string): UndoResult;
  coverage(accountId: string): KindCoverage[];
}

interface Pending {
  readonly accountId: string;
  readonly expiresAt: number;
  readonly files: readonly ParsedFile[];
}

interface Account {
  readonly id: string;
  readonly broker: string;
}

function checkBounds(files: readonly ImportFile[]): void {
  if (files.length === 0) throw new ImportError('no files to preview');
  if (files.length > MAX_PREVIEW_FILES) throw new ImportError('too many files in one preview');
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > MAX_PREVIEW_BYTES) throw new ImportError('the files are too large to preview together');
}

export function createImportService(options: ImportServiceOptions): ImportService {
  const { db, vaultPath, appVersion } = options;
  const now = options.now ?? (() => new Date());
  const adapters = options.adapters ?? DEFAULT_ADAPTERS;
  const pending = new Map<string, Pending>();

  const accountOf = (accountId: string): Account => {
    const account = db.prepare('SELECT id, broker FROM broker_account WHERE id = ?').get(accountId) as
      Account | undefined;
    if (account === undefined) throw new ImportError('unknown account');
    return account;
  };

  const forgetExpired = (): void => {
    const at = now().getTime();
    for (const [token, entry] of pending) if (entry.expiresAt <= at) pending.delete(token);
  };

  const remember = (entry: Pending): string => {
    while (pending.size >= MAX_PENDING_PREVIEWS) {
      const [oldest] = pending.keys();
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    pending.set(token, entry);
    return token;
  };

  return {
    async previewImport(accountId, files) {
      forgetExpired();
      checkBounds(files);
      const account = accountOf(accountId);
      const seen: SeenKeys = { rows: new Set(), statements: new Set() };
      const previews: FilePreview[] = [];
      const parsed: ParsedFile[] = [];
      for (const [index, file] of files.entries()) {
        const label = file.name === undefined ? null : file.name.slice(0, MAX_LABEL_CHARS);
        const outcome = await previewFile(
          { db, adapters, forecast: options.forecast },
          account,
          file,
          { index, label },
          seen,
        );
        previews.push(outcome.preview);
        if (outcome.parsed !== null) parsed.push(outcome.parsed);
      }
      const expiresAt = now().getTime() + PREVIEW_TTL_MS;
      const token = parsed.length > 0 ? remember({ accountId, expiresAt, files: parsed }) : null;
      return { token, expiresAt: new Date(expiresAt).toISOString(), files: previews };
    },

    commitImport(token) {
      forgetExpired();
      const entry = pending.get(token);
      if (entry === undefined) throw new ImportError('the preview has expired; preview the files again');
      accountOf(entry.accountId);
      const at = now();
      try {
        autoBackup(db, vaultPath, 'pre-import', { appVersion, now: () => at });
      } catch (error) {
        throw new ImportError('could not back up the vault before importing; nothing was written', {
          cause: error,
        });
      }
      let batches: CommittedBatch[];
      try {
        batches = db.transaction(() => writeBatches(db, entry.accountId, entry.files, at.toISOString()))();
      } catch (error) {
        throw new ImportError('the import failed; nothing was written', { cause: error });
      }
      // Single use: forgotten only once committed, so a failed commit can be retried.
      pending.delete(token);
      options.onChanged?.(entry.accountId);
      return { batches };
    },

    undoImport(batchId) {
      // Cheap check first, so an unknown or already-undone batch never costs a backup.
      if (db.prepare('SELECT 1 FROM import_batch WHERE id = ?').get(batchId) === undefined) {
        throw new ImportError('unknown import batch');
      }
      const at = now();
      try {
        autoBackup(db, vaultPath, 'pre-undo', { appVersion, now: () => at });
      } catch (error) {
        throw new ImportError('could not back up the vault before the undo; nothing was changed', {
          cause: error,
        });
      }
      let result: UndoResult;
      try {
        result = db.transaction(() => removeBatch(db, batchId))();
      } catch (error) {
        if (error instanceof ImportError) throw error;
        throw new ImportError('the undo failed; nothing was changed', { cause: error });
      }
      options.onChanged?.(result.accountId);
      return result;
    },

    coverage(accountId) {
      accountOf(accountId);
      return accountCoverage(db, accountId);
    },
  };
}
