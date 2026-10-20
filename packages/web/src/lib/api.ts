// The typed RPC client for the local server (`hc<ApiRoutes>`, PRD §12.1). Requests go to the same origin and
// carry the session cookie; the server's errors are fixed codes (ADR-0019), surfaced here as ApiError. A request
// that never gets a response (the BhavBook process has stopped) is an ApiError too, with status 0.
import type { ApiRoutes } from '@bhavbook/server';
import { hc } from 'hono/client';
import type { Disconnection } from '@/components/states';

export const api = hc<ApiRoutes>('/api', { init: { credentials: 'same-origin' } });

/** A failed request: the HTTP status (0 when nothing answered) and the server's fixed error code. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`request failed: ${code}`);
  }

  /** Why the page cannot talk to BhavBook at all, or null for an ordinary failure. */
  get disconnection(): Disconnection | null {
    if (this.status === 0) return 'stopped';
    if (this.status === 401) return 'ended';
    if (this.status === 403) return 'refused';
    return null;
  }
}

function errorCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return 'unexpected_response';
}

/** Sends a request; a network failure (no server) becomes ApiError(0, 'unreachable'). */
export async function send(request: () => Promise<Response>): Promise<Response> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(0, 'unreachable');
    throw error;
  }
}

/** The JSON body of a successful response, or an ApiError. */
export async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, errorCode(body));
  return body;
}

const RETRY_LIMIT = 1;

/** Retry once, and only what can succeed on retry: a stopped server or a 5xx. Never 4xx or a malformed body. */
export function shouldRetry(failures: number, error: unknown): boolean {
  if (failures >= RETRY_LIMIT || !(error instanceof ApiError)) return false;
  return error.status === 0 || error.status >= 500;
}
