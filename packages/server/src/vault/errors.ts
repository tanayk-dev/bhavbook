// Vault errors. Messages never contain row data or file contents (ADR-0019).

export class VaultError extends Error {
  override readonly name: string = 'VaultError';
}

/** What went wrong with a backup or restore, as the person can act on it (shown by the UI as a fixed message). */
export type BackupProblem = 'in_use' | 'newer_version' | 'not_a_backup' | 'corrupt' | 'too_large' | 'failed';

/** A `.bhav` backup is malformed, corrupted, or from an incompatible version; or a backup or restore failed. */
export class BackupError extends VaultError {
  override readonly name = 'BackupError';
  readonly problem: BackupProblem;

  constructor(message: string, options: ErrorOptions & { readonly problem?: BackupProblem } = {}) {
    super(message, options);
    this.problem = options.problem ?? 'failed';
  }
}
