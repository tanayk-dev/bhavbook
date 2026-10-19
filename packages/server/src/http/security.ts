// ADR-0002: one check for every HTTP request and WebSocket upgrade. Host must be 127.0.0.1:<port> or
// localhost:<port> (defeats DNS rebinding); Origin, when sent, must be the app's own; and the per-launch session
// token must be present. Order matters: Host and Origin are checked before the token, so a foreign page learns
// nothing about it. There is no CORS.
import { createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'bhavbook_session';

export type CheckResult = { readonly ok: true } | { readonly ok: false; readonly status: 401 | 403 };

export interface RequestFacts {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  /** The raw Cookie header. */
  readonly cookie: string | undefined;
}

export function allowedHosts(port: number): readonly string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function allowedOrigins(port: number): readonly string[] {
  return allowedHosts(port).map((host) => `http://${host}`);
}

/** Constant-time comparison of two secrets of any length (both are hashed first). */
export function sameSecret(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** The session cookie's value, or undefined. Only the first occurrence counts. */
export function sessionCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === SESSION_COOKIE)
      return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** Host and Origin only: whether the request comes from the app itself on this port. */
export function checkOrigin(facts: RequestFacts, port: number): boolean {
  if (facts.host === undefined || !allowedHosts(port).includes(facts.host.toLowerCase())) return false;
  return facts.origin === undefined || allowedOrigins(port).includes(facts.origin.toLowerCase());
}

export function checkRequest(facts: RequestFacts, port: number, token: string): CheckResult {
  if (!checkOrigin(facts, port)) return { ok: false, status: 403 };
  const presented = sessionCookie(facts.cookie);
  if (presented === undefined || !sameSecret(presented, token)) return { ok: false, status: 401 };
  return { ok: true };
}

/** Headers on every response: no sniffing, no framing, no referrer (the launch URL carries the token), no caching. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
