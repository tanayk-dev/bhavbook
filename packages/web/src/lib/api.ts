// The typed RPC client for the local server (`hc<ApiRoutes>`, PRD §12.1). Requests go to the same origin and
// carry the session cookie; the server's errors are fixed codes (ADR-0019), surfaced here as ApiError.
import type { ApiRoutes } from '@bhavbook/server';
import { hc } from 'hono/client';

export const api = hc<ApiRoutes>('/api', { init: { credentials: 'same-origin' } });

/** A failed request: the HTTP status and the server's fixed error code. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`request failed: ${code}`);
  }

  /** The session cookie is missing or rejected: the user restarts BhavBook from the terminal. */
  get sessionEnded(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function errorCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return 'unexpected_response';
}

/** The JSON body of a successful response, or an ApiError. */
export async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, errorCode(body));
  return body;
}
