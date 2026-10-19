// Vault errors. Messages never contain row data or file contents (ADR-0019).

export class VaultError extends Error {
  override readonly name: string = 'VaultError';
}

/** A `.bhav` backup is malformed, corrupted, or from an incompatible version. */
export class BackupError extends VaultError {
  override readonly name = 'BackupError';
}
