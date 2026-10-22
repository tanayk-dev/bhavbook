// Errors of user actions (adjustments, instrument mapping, issues, journal). Messages are fixed strings (ADR-0019);
// the `code` is what the HTTP layer answers with, so a reworded message never changes what the UI shows.
/** `stale`: the thing changed since the client read it (a journal form over a newer entry). */
export type ActionErrorCode = 'not_found' | 'invalid' | 'conflict' | 'stale' | 'failed';

export class ActionError extends Error {
  override readonly name: string = 'ActionError';
  readonly code: ActionErrorCode;

  constructor(message: string, options: ErrorOptions & { readonly code?: ActionErrorCode } = {}) {
    super(message, options);
    this.code = options.code ?? 'failed';
  }
}
