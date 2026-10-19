// ADR-0002: one check for every HTTP request and WebSocket upgrade, in this order (a foreign page learns nothing
// about the token):
//   1. Host must be 127.0.0.1:<port> or localhost:<port> (defeats DNS rebinding);
//   2. Origin, when sent, must be the app's own; state-changing methods must send it;
//   3. Sec-Fetch-Site, when sent, must be same-origin or none. Cookies ignore ports, so SameSite=Strict alone
//      would let a page on another localhost port make blind requests with our cookie;
//   4. the per-launch session token, from a cookie named per port.
// There is no CORS.
import { createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_PREFIX = 'bhavbook_session';

export type CheckResult = { readonly ok: true } | { readonly ok: false; readonly status: 401 | 403 };

export interface RequestFacts {
  readonly method: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly fetchSite: string | undefined;
  /** The raw Cookie header. */
  readonly cookie: string | undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const SAME_ORIGIN_FETCH = new Set(['same-origin', 'none']);

/** Per port, so two instances (or other apps on 127.0.0.1) never read or overwrite each other's cookie. */
export function sessionCookieName(port: number): string {
  return `${SESSION_COOKIE_PREFIX}_${String(port)}`;
}

export function allowedHosts(port: number): readonly string[] {
  return [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
}

export function allowedOrigins(port: number): readonly string[] {
  return allowedHosts(port).map((host) => `http://${host}`);
}

/** Constant-time comparison of two secrets of any length (both are hashed first). */
export function sameSecret(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** A cookie's value from a Cookie header, or undefined. Only the first occurrence counts. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** Steps 1-3: whether the request comes from the app itself on this port. */
export function checkOrigin(facts: RequestFacts, port: number): boolean {
  if (facts.host === undefined || !allowedHosts(port).includes(facts.host.toLowerCase())) return false;
  if (facts.origin === undefined) {
    if (!SAFE_METHODS.has(facts.method.toUpperCase())) return false;
  } else if (!allowedOrigins(port).includes(facts.origin.toLowerCase())) {
    return false;
  }
  return facts.fetchSite === undefined || SAME_ORIGIN_FETCH.has(facts.fetchSite.toLowerCase());
}

export function checkRequest(facts: RequestFacts, port: number, token: string): CheckResult {
  if (!checkOrigin(facts, port)) return { ok: false, status: 403 };
  const presented = cookieValue(facts.cookie, sessionCookieName(port));
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
