// Import errors carry fixed messages only (ADR-0019); the underlying error, if any, is the `cause`.
export class ImportError extends Error {
  override readonly name = 'ImportError';
}
