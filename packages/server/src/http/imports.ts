// Imports over HTTP (S13b, PRD §5.1): the import service bound to the live vault connection. A restore replaces
// that connection, so the service is rebuilt whenever the connection changes (its pending previews belonged to the
// old vault and are dropped with it). Commits and undos recompute the account (recomputeHooks).
import type { Context } from 'hono';
import {
  createImportService,
  ImportError,
  MAX_PREVIEW_FILES,
  type ImportFile,
  type ImportService,
} from '../import/index.js';
import { recomputeHooks } from '../recompute/index.js';
import type { BackupHost, LiveVault } from './backups.js';

/** The import service for whatever vault is live now, or null without a vault or a host (tests without one). */
export function importServices(live: LiveVault, host: BackupHost | undefined): () => ImportService | null {
  let bound: { readonly db: unknown; readonly service: ImportService } | null = null;
  return () => {
    if (live.db === null) live.recover?.();
    const db = live.db;
    if (db === null || host === undefined) return null;
    if (bound?.db !== db) {
      const service = createImportService({
        db,
        vaultPath: host.vaultPath,
        appVersion: host.appVersion,
        ...recomputeHooks(db),
      });
      bound = { db, service };
    }
    return bound.service;
  };
}

const KIND = /^[a-z]+\.[a-z0-9_]+$/;

/**
 * The files of a preview request: multipart `file` parts, each optionally paired with a `kind` part (the person's
 * pick for an ambiguous file; empty for "detect"). File names are not read: the browser keeps them (ADR-0019).
 */
export async function previewFiles(c: Context): Promise<ImportFile[]> {
  let body: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (cause) {
    // A malformed multipart body (bad boundary, truncated part) is the client's mistake, not a server failure.
    throw new PreviewRequestError('the upload could not be read', { cause });
  }
  const files = [body.file ?? []].flat();
  const kinds = [body.kind ?? []].flat();
  if (files.length > MAX_PREVIEW_FILES)
    throw new ImportError('too many files in one preview', { code: 'too_many_files' });
  // Kinds pair with files by position, so there is one per file or none at all.
  if (kinds.length !== 0 && kinds.length !== files.length) throw new PreviewRequestError();
  return Promise.all(
    files.map(async (file, index) => {
      if (typeof file === 'string') throw new PreviewRequestError();
      const kind = kinds[index];
      // A view over the part's bytes, not a second copy.
      const bytes = Buffer.from(await file.arrayBuffer());
      return typeof kind === 'string' && KIND.test(kind) ? { bytes, kind } : { bytes };
    }),
  );
}

/** A preview request whose parts don't fit the contract (a text part where a file belongs, unpaired kinds). */
export class PreviewRequestError extends Error {
  override readonly name = 'PreviewRequestError';
}
