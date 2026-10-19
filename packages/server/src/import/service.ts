// The import service: preview (writes nothing, returns a 15-minute single-use token) and commit (pre-import backup,
// one transaction, then the recompute hook). Previews live in memory only.
import { randomBytes } from 'node:crypto';
import { dhanAdapter, zerodhaAdapter, type BrokerAdapter } from '@bhavbook/adapters';
import type Database from 'better-sqlite3';
import { autoBackup } from '../vault/index.js';
import { writeBatches, type CommittedBatch } from './commit.js';
import { previewFile, type FilePreview, type ImportFile, type ParsedFile, type SeenKeys } from './preview.js';
import { ImportError } from './read.js';

export const PREVIEW_TTL_MS = 15 * 60 * 1000;
/** Previews kept at once; the oldest is dropped first (each holds parsed files in memory). */
export const MAX_PENDING_PREVIEWS = 8;

export const DEFAULT_ADAPTERS: readonly BrokerAdapter[] = [zerodhaAdapter, dhanAdapter];

export interface ImportServiceOptions {
  readonly db: Database.Database;
  readonly vaultPath: string;
  readonly appVersion: string;
  readonly now?: () => Date;
  /** Called after every change to an account's rows; the recompute trigger (a no-op until S9). */
  readonly onChanged?: (accountId: string) => void;
  readonly adapters?: readonly BrokerAdapter[];
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
    while (pending.size >= MAX_PENDING_PREVIEWS) {
      const [oldest] = pending.keys();
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
  };

  return {
    async previewImport(accountId, files) {
      const account = accountOf(accountId);
      const seen: SeenKeys = { rows: new Set(), statements: new Set() };
      const previews: FilePreview[] = [];
      const parsed: ParsedFile[] = [];
      for (const [index, file] of files.entries()) {
        const outcome = await previewFile(
          { db, adapters },
          account,
          file,
          { index, label: file.name ?? null },
          seen,
        );
        previews.push(outcome.preview);
        if (outcome.parsed !== null) parsed.push(outcome.parsed);
      }
      const expiresAt = now().getTime() + PREVIEW_TTL_MS;
      let token: string | null = null;
      if (parsed.length > 0) {
        forgetExpired();
        token = randomBytes(32).toString('base64url');
        pending.set(token, { accountId, expiresAt, files: parsed });
      }
      return { token, expiresAt: new Date(expiresAt).toISOString(), files: previews };
    },

    commitImport(token) {
      const entry = pending.get(token);
      pending.delete(token);
      if (entry === undefined || entry.expiresAt <= now().getTime()) {
        throw new ImportError('the preview has expired; preview the files again');
      }
      accountOf(entry.accountId);
      const at = now();
      autoBackup(db, vaultPath, 'pre-import', { appVersion, now: () => at });
      let batches: CommittedBatch[];
      try {
        batches = db.transaction(() => writeBatches(db, entry.accountId, entry.files, at.toISOString()))();
      } catch (error) {
        throw new ImportError('the import failed; nothing was written', { cause: error });
      }
      options.onChanged?.(entry.accountId);
      return { batches };
    },
  };
}
