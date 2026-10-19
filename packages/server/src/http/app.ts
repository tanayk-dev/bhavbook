// The local HTTP app (ADR-0001, ADR-0002). Middleware order is the security contract:
//   1. hardening headers + request log (route pattern, status, timing only)
//   2. Host/Origin allowlist, then the session token (launch URL -> cookie)
//   3. routes: the typed /api tree (501 until each step implements its service), then the web build
// Errors never echo bodies, messages or cell values (ADR-0019).
import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import type Database from 'better-sqlite3';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { currentVersion } from '../vault/index.js';
import { jsonResponse } from './json.js';
import type { Logger } from './logger.js';
import {
  checkOrigin,
  checkRequest,
  sameSecret,
  SECURITY_HEADERS,
  sessionCookieName,
  type RequestFacts,
} from './security.js';

/** Largest JSON request body (imports upload files through their own route in S7, not as JSON). */
export const MAX_JSON_BYTES = 1024 * 1024;

export interface AppOptions {
  readonly token: string;
  /** The port the server listens on; known only after listen(), hence a getter. */
  readonly port: () => number;
  readonly logger: Logger;
  readonly vault: Database.Database | null;
  /** Directory holding the web build (S13a). Missing or null serves a placeholder page. */
  readonly staticRoot?: string | null;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 415 | 500 | 501 | 503;

const error = (code: string, status: ErrorStatus): Response => jsonResponse({ error: code }, status);

/** Fixed bodies for client errors raised as HTTPExceptions (by Hono helpers or handlers): the status is kept. */
const CLIENT_ERRORS: ReadonlyMap<number, readonly [string, ErrorStatus]> = new Map([
  [401, ['unauthorized', 401]],
  [403, ['forbidden', 403]],
  [404, ['not_found', 404]],
  [413, ['payload_too_large', 413]],
  [415, ['unsupported_media_type', 415]],
]);

const notImplemented = (): Response => error('not_implemented', 501);

const idParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/**
 * Placeholder body schema for routes whose step has not defined one yet: any JSON object. The implementing step
 * replaces it with the real schema.
 */
const pendingBody = z.looseObject({});

function params<T extends z.ZodType>(schema: T) {
  return validator('param', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return error('invalid_request', 400);
    return parsed.data;
  });
}

/** JSON bodies: application/json only, size-capped, parsed, then validated. Failures never echo the input. */
function json<T extends z.ZodType>(schema: T) {
  const contentType: MiddlewareHandler = async (c, next) => {
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json(;|$)/i.test(type)) return error('unsupported_media_type', 415);
    await next();
    return undefined;
  };
  const limit = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: () => error('payload_too_large', 413) });
  const parse = validator('json', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return error('invalid_request', 400);
    return parsed.data;
  });
  return [contentType, limit, parse] as const;
}

function apiRoutes(options: AppOptions) {
  return new Hono()
    .get('/health', () => jsonResponse({ ok: true }))
    .get('/vault', () =>
      options.vault === null
        ? error('no_vault', 503)
        : jsonResponse({ schemaVersion: currentVersion(options.vault) }),
    )
    .post('/vault/backup', notImplemented)
    .post('/vault/restore', notImplemented)
    .get('/imports', notImplemented)
    .post('/imports', notImplemented)
    .get('/coverage', notImplemented)
    .get('/issues', notImplemented)
    .post('/issues/:id/resolve', params(idParam), notImplemented)
    .get('/positions', notImplemented)
    .get('/positions/:id', params(idParam), notImplemented)
    .get('/journal', notImplemented)
    .post('/journal', ...json(pendingBody), notImplemented)
    .get('/settings', notImplemented)
    .put('/settings', ...json(pendingBody), notImplemented)
    .get('/analytics/summary', notImplemented);
}

/** The typed RPC surface for the web client (`hc<ApiRoutes>`). */
export type ApiRoutes = ReturnType<typeof apiRoutes>;

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BhavBook</title></head>
<body><h1>BhavBook</h1><p>The server is running. The web interface is not built yet.</p></body></html>`;

function logAndHarden(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    try {
      await next();
    } catch {
      // Hono's onError only sees Error instances; anything else thrown ends up here.
      logger.error('request_failed', { path: routePath(c, -1), error: 'non_error' });
      c.res = error('internal_error', 500);
    }
    try {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
    } catch {
      // Some responses (e.g. Response.redirect) have immutable headers: copy, then harden.
      c.res = new Response(c.res.body, c.res);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
    }
    logger.info('request', {
      method: c.req.method,
      // The matched route pattern (`/api/positions/:id`), never the raw path or query string.
      path: routePath(c, -1),
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}

function guard(options: AppOptions): MiddlewareHandler {
  return async (c, next) => {
    const facts: RequestFacts = {
      method: c.req.method,
      host: c.req.header('host'),
      origin: c.req.header('origin'),
      fetchSite: c.req.header('sec-fetch-site'),
      cookie: c.req.header('cookie'),
    };
    const port = options.port();
    if (!checkOrigin(facts, port)) return error('forbidden', 403);
    const launchToken = c.req.method === 'GET' && c.req.path === '/' ? c.req.query('t') : undefined;
    if (launchToken !== undefined) {
      if (!sameSecret(launchToken, options.token)) return error('unauthorized', 401);
      setCookie(c, sessionCookieName(port), options.token, { httpOnly: true, sameSite: 'Strict', path: '/' });
      return c.redirect('/', 302);
    }
    const result = checkRequest(facts, port, options.token);
    if (!result.ok) return error(result.status === 403 ? 'forbidden' : 'unauthorized', result.status);
    await next();
    return undefined;
  };
}

/** True when any path segment (after percent-decoding) starts with a dot: `.env`, `.git/`, `..`. */
function hasDotSegment(requestPath: string): boolean {
  try {
    return requestPath.split('/').some((segment) => decodeURIComponent(segment).startsWith('.'));
  } catch {
    return true;
  }
}

function webRoutes(app: Hono, staticRoot: string | null | undefined): void {
  if (staticRoot != null && existsSync(staticRoot)) {
    app.get('*', async (c, next) => {
      if (hasDotSegment(c.req.path)) return error('not_found', 404);
      await next();
      return undefined;
    });
    app.get('*', serveStatic({ root: staticRoot }));
    return;
  }
  app.get('/', (c: Context) => c.html(PLACEHOLDER_PAGE));
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  app.use('*', logAndHarden(options.logger));
  app.use('*', guard(options));
  app.route('/api', apiRoutes(options));
  webRoutes(app, options.staticRoot);
  app.notFound(() => error('not_found', 404));
  app.onError((cause, c) => {
    if (cause instanceof HTTPException && cause.status < 500) {
      const [code, status] = CLIENT_ERRORS.get(cause.status) ?? ['invalid_request', 400];
      return error(code, status);
    }
    // The error's name only: messages can quote file content or request data.
    options.logger.error('request_failed', { path: routePath(c, -1), error: cause.name });
    return error('internal_error', 500);
  });
  return app;
}
