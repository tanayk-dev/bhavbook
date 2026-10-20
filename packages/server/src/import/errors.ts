// Import errors carry fixed messages only (ADR-0019); the underlying error, if any, is the `cause`. The `code` is
// what the HTTP layer answers with, so a reworded message never changes what the UI shows.
export type ImportErrorCode =
  'not_found' | 'no_files' | 'too_large' | 'preview_expired' | 'backup_failed' | 'failed';

export class ImportError extends Error {
  override readonly name = 'ImportError';
  readonly code: ImportErrorCode;

  constructor(message: string, options: ErrorOptions & { readonly code?: ImportErrorCode } = {}) {
    super(message, options);
    this.code = options.code ?? 'failed';
  }
}
