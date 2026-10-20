// Backups: the list, a manual backup, download links, and the two restores (a listed backup, or a `.bhav` file the
// person picks). Responses are untrusted JSON; restore errors are fixed codes turned into messages here.
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

export interface Backup {
  readonly name: string;
  readonly kind: 'manual' | 'auto';
  readonly reason: string;
  readonly createdAt: string;
  readonly bytes: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export function backup(value: unknown): Backup {
  if (
    isRecord(value) &&
    typeof value.name === 'string' &&
    /^[a-z0-9-]{1,80}\.bhav$/i.test(value.name) &&
    (value.kind === 'manual' || value.kind === 'auto') &&
    typeof value.reason === 'string' &&
    typeof value.createdAt === 'string' &&
    // An explicit zone, so the machine's own timezone never interprets it.
    /(Z|[+-]\d\d:\d\d)$/.test(value.createdAt) &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  ) {
    return {
      name: value.name,
      kind: value.kind,
      reason: value.reason,
      createdAt: value.createdAt,
      bytes: value.bytes,
    };
  }
  throw new ApiError(200, 'unexpected_response');
}

export function backups(body: unknown): Backup[] {
  if (isRecord(body) && Array.isArray(body.backups)) return body.backups.map(backup);
  throw new ApiError(200, 'unexpected_response');
}

export const backupsQuery = queryOptions({
  queryKey: ['backups'],
  queryFn: async () => backups(await readJson(await send(() => api.vault.backups.$get()))),
});

export async function backUpNow(): Promise<Backup> {
  return backup(await readJson(await send(() => api.vault.backup.$post())));
}

/** Where the browser downloads a listed backup (same origin, so the session cookie goes with it). */
export const downloadUrl = (name: string): string => `/api/vault/backups/${encodeURIComponent(name)}`;

export async function restoreBackup(name: string): Promise<void> {
  await readJson(await send(() => api.vault.restore.$post({ json: { name } })));
}

export async function restoreFile(file: Blob): Promise<void> {
  await readJson(
    await send(() =>
      fetch('/api/vault/restore/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      }),
    ),
  );
}

/** Failures where the server says nothing was changed. */
const RESTORE_ERRORS: Readonly<Record<string, string>> = {
  in_use: 'Another program has the vault open. Close it and try again.',
  newer_version: 'This backup was made by a newer version of BhavBook. Update BhavBook, then restore it.',
  not_a_backup: 'That file is not a BhavBook backup.',
  corrupt: 'That backup is damaged, so it was not restored.',
  too_large: 'That file is too large to be a BhavBook backup.',
  payload_too_large: 'That file is too large to be a BhavBook backup.',
  not_found: 'That backup no longer exists. Reload the page.',
  busy: 'Another restore is running. Wait for it to finish.',
};

/** What to tell the person when a restore failed. "Unchanged" only when the server said so. */
export function restoreError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : '';
  const reason = RESTORE_ERRORS[code];
  if (reason !== undefined) return `${reason} Your current data is unchanged.`;
  if (code === 'reopen_failed') {
    return 'BhavBook could not reopen its data after the restore. Reload the page; if that fails, restart BhavBook.';
  }
  return 'The restore did not report back, so it may or may not have happened. Reload the page to see your data.';
}

const REASONS: Readonly<Record<string, string>> = {
  manual: 'Made by you',
  'pre-import': 'Before an import',
  'pre-undo': 'Before an undo',
  'pre-migration': 'Before an upgrade',
  'pre-restore': 'Before a restore',
};

export const backupReason = (reason: string): string => REASONS[reason] ?? reason;

/** "48 KB", "1.2 MB": sizes on screen. */
export function formatBytes(bytes: number): string {
  const kib = 1024;
  const kb = Math.max(1, Math.round(bytes / kib));
  if (kb < kib) return `${kb.toLocaleString('en-IN')} KB`;
  return `${(bytes / (kib * kib)).toFixed(1)} MB`;
}
