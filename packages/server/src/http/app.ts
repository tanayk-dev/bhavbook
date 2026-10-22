// The local HTTP app (ADR-0001, ADR-0002). Middleware order is the security contract:
//   1. hardening headers + request log (route pattern, status, timing only)
//   2. Host/Origin allowlist, then the session token (launch URL -> cookie)
//   3. routes: the typed /api tree (501 until each step implements its service), then the web build
// Errors never echo bodies, messages or cell values (ADR-0019).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { serveStatic } from '@hono/node-server/serve-static';
import type Database from 'better-sqlite3';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import { validator } from 'hono/validator';
import { z } from 'zod';
import {
  accountInputSchema,
  createAccount,
  createProfile,
  listProfiles,
  moveAccount,
  moveAccountSchema,
  ProfileError,
  profileInputSchema,
  renameAccount,
  renameAccountSchema,
  renameProfile,
  renameProfileSchema,
} from '../services/profiles.js';
import { breakevenSchema, readSettings, setBreakeven } from '../services/settings.js';
import { adjustmentInputSchema } from '../services/adjustments.js';
import { ActionError, type ActionErrorCode } from '../services/errors.js';
import {
  addAttachment,
  deleteAttachment,
  MAX_ATTACHMENT_BYTES,
  readAttachment,
} from '../services/attachments.js';
import {
  journalInputSchema,
  mergeCollision,
  mergeSchema,
  saveJournal,
  setReviewed,
} from '../services/journal.js';
import {
  listPositions,
  positionDetail,
  positionRefSchema,
  positionsFilterSchema,
  reviewCountSchema,
  reviewQueueCount,
} from '../services/positions.js';
import {
  instrumentNames,
  issueFilterSchema,
  issueSummary,
  listIssues,
  mapInstrumentSchema,
  mapIssueInstrument,
  reopenIssue,
  suggestionsForIssue,
  applyAccountAdjustment,
} from '../services/issues.js';
import {
  acceptStatementSuggestion,
  dismissIssue,
  replaceRedundantLot,
  restoreAndRecompute,
  revertAndRecompute,
} from '../recompute/actions.js';
import { ImportError, MAX_PREVIEW_BYTES, type ImportErrorCode, type ImportService } from '../import/index.js';
import {
  createTag,
  deleteTag,
  listTags,
  mergeTag,
  mergeTagSchema,
  renameTag,
  renameTagSchema,
  tagInputSchema,
} from '../services/tags.js';
import { recompute } from '../recompute/index.js';
import { backupPath, currentVersion, listBackups, manualBackup, MAX_BACKUP_BYTES } from '../vault/index.js';
import {
  liveVault,
  restoreErrorCode,
  restoreListed,
  restoreUpload,
  type BackupHost,
  type LiveVault,
  type RestoreErrorCode,
} from './backups.js';
import { importServices, PreviewRequestError, previewFiles } from './imports.js';
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
  /** Where the vault lives and how to reopen it, for backups and restore. Absent: those routes answer 503. */
  readonly backups?: BackupHost;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 500 | 501 | 503;

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
const refParam = z.object({ ref: positionRefSchema });
/** A backup file name; the catalog resolves only names it would have made itself. */
const backupParam = z.object({ name: z.string().regex(/^[a-z0-9-]{1,80}\.bhav$/i) });
const restoreSchema = z.object({ name: z.string().max(80) }).strict();

function params<T extends z.ZodType>(schema: T) {
  return validator('param', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return error('invalid_request', 400);
    return parsed.data;
  });
}

/** JSON bodies: application/json only, size-capped, parsed, then validated. Failures never echo the input. */
function json<T extends z.ZodType>(schema: T, maxSize = MAX_JSON_BYTES) {
  const contentType: MiddlewareHandler = async (c, next) => {
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json(;|$)/i.test(type)) return error('unsupported_media_type', 415);
    await next();
    return undefined;
  };
  const limit = bodyLimit({ maxSize, onError: () => error('payload_too_large', 413) });
  const parse = validator('json', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return error('invalid_request', 400);
    return parsed.data;
  });
  return [contentType, limit, parse] as const;
}

/** A `.bhav` upload: application/octet-stream only, capped at the largest backup restore will read. */
function upload() {
  const contentType: MiddlewareHandler = async (c, next) => {
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/octet-stream(;|$)/i.test(type)) return error('unsupported_media_type', 415);
    await next();
    return undefined;
  };
  return [
    contentType,
    bodyLimit({ maxSize: MAX_BACKUP_BYTES, onError: () => error('payload_too_large', 413) }),
  ] as const;
}

/** A journal screenshot: WebP only (the browser re-encodes every image), at most 1 MB. */
function webpUpload() {
  const contentType: MiddlewareHandler = async (c, next) => {
    const type = c.req.header('content-type') ?? '';
    if (!/^image\/webp(;|$)/i.test(type)) return error('unsupported_media_type', 415);
    await next();
    return undefined;
  };
  return [
    contentType,
    bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES, onError: () => error('payload_too_large', 413) }),
  ] as const;
}

const accountQuery = z.object({ accountId: z.string().min(1).max(64) });
const commitSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
/** Multipart overhead on top of the files themselves (boundaries, part headers, the account and kind fields). */
const MULTIPART_SLACK_BYTES = 64 * 1024;

function query<T extends z.ZodType>(schema: T) {
  return validator('query', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return error('invalid_request', 400);
    return parsed.data;
  });
}

/** A multipart upload of import files, capped at what one preview may hold. */
function multipart() {
  const contentType: MiddlewareHandler = async (c, next) => {
    const type = c.req.header('content-type') ?? '';
    if (!/^multipart\/form-data;/i.test(type)) return error('unsupported_media_type', 415);
    await next();
    return undefined;
  };
  const limit = bodyLimit({
    maxSize: MAX_PREVIEW_BYTES + MULTIPART_SLACK_BYTES,
    onError: () => error('payload_too_large', 413),
  });
  return [contentType, limit] as const;
}

const IMPORT_STATUS: Readonly<Record<Exclude<ImportErrorCode, 'failed'>, ErrorStatus>> = {
  not_found: 404,
  no_files: 400,
  too_large: 413,
  too_many_files: 413,
  preview_expired: 410,
  backup_failed: 500,
};

/** Runs an import action; an ImportError answers its fixed code, anything unexpected is a 500. */
async function withImports(
  services: () => ImportService | null,
  action: (service: ImportService) => Promise<Response> | Response,
): Promise<Response> {
  const service = services();
  if (service === null) return error('no_vault', 503);
  try {
    return await action(service);
  } catch (cause) {
    if (cause instanceof ImportError && cause.code !== 'failed')
      return error(cause.code, IMPORT_STATUS[cause.code]);
    if (cause instanceof PreviewRequestError) return error('invalid_request', 400);
    throw cause;
  }
}

const ACTION_STATUS: Readonly<Record<Exclude<ActionErrorCode, 'failed'>, ErrorStatus>> = {
  not_found: 404,
  invalid: 400,
  conflict: 409,
};

/** Runs an issue or adjustment action; an ActionError answers its fixed code, anything else is a 500. */
function withAction<R extends Response>(live: LiveVault, action: (db: Database.Database) => R): R | Response {
  return withVault(live, (db) => {
    try {
      return action(db);
    } catch (cause) {
      if (cause instanceof ActionError && cause.code !== 'failed') {
        return error(cause.code, ACTION_STATUS[cause.code]);
      }
      throw cause;
    }
  });
}

/** Every instrument key an issue subject names (`instrumentKey`, `isin`), for display names. */
function subjectKeys(subjects: readonly unknown[]): string[] {
  return subjects.flatMap((subject) => {
    if (typeof subject !== 'object' || subject === null) return [];
    const record = subject as Record<string, unknown>;
    return [record.instrumentKey, record.isin].filter((key): key is string => typeof key === 'string');
  });
}

/** A journal entry: two texts of at most 10,000 characters and a few ids. */
const JOURNAL_JSON_BYTES = 64 * 1024;

/** Profile and account bodies are a few short labels. */
const SMALL_JSON_BYTES = 4 * 1024;

const PROFILE_ERRORS: Readonly<Record<ProfileError['code'], ErrorStatus>> = {
  invalid: 400,
  identifier: 400,
  conflict: 409,
  not_found: 404,
  recompute_failed: 409,
};

/** Runs a vault action; a missing vault is 503 and a ProfileError its fixed code (ADR-0019). */
function withVault<R extends Response | Promise<Response>>(
  live: LiveVault,
  action: (db: Database.Database) => R,
): R | Response {
  // After a restore that could not reopen the vault, every request tries again.
  if (live.db === null) live.recover?.();
  if (live.db === null) return error('no_vault', 503);
  try {
    return action(live.db);
  } catch (cause) {
    if (cause instanceof ProfileError) return error(cause.code, PROFILE_ERRORS[cause.code]);
    throw cause;
  }
}

/** Runs a backup action against the live vault; 503 without a vault or a backup host. */
function withBackups<R extends Response | Promise<Response>>(
  live: LiveVault,
  host: BackupHost | undefined,
  action: (db: Database.Database, host: BackupHost) => R,
): R | Response {
  if (host === undefined) return error('no_vault', 503);
  return withVault(live, (db) => action(db, host));
}

const RESTORE_STATUS: Readonly<Record<Exclude<RestoreErrorCode, 'restore_failed'>, ErrorStatus>> = {
  in_use: 409,
  busy: 409,
  reopen_failed: 503,
  too_large: 413,
  newer_version: 422,
  not_a_backup: 422,
  corrupt: 422,
};

/** Restores, answering the restore's fixed error code; anything unexpected is a 500 (logged by name only). */
async function restoreResponse(
  restore: () => Promise<{ schemaVersion: number }> | { schemaVersion: number },
) {
  try {
    return jsonResponse(await restore());
  } catch (cause) {
    const code = restoreErrorCode(cause);
    if (code === 'restore_failed') throw cause;
    return error(code, RESTORE_STATUS[code]);
  }
}

function apiRoutes(options: AppOptions, live: LiveVault) {
  const host = options.backups;
  const imports = importServices(live, host);
  return (
    new Hono()
      .get('/health', () => jsonResponse({ ok: true }))
      .get('/vault', () =>
        live.db === null ? error('no_vault', 503) : jsonResponse({ schemaVersion: currentVersion(live.db) }),
      )
      .get('/profiles', (c) => withVault(live, (db) => c.json({ profiles: listProfiles(db) })))
      .post('/profiles', ...json(profileInputSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) => c.json({ id: createProfile(db, c.req.valid('json')) }, 201)),
      )
      .post('/accounts', ...json(accountInputSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) => c.json({ id: createAccount(db, c.req.valid('json')) }, 201)),
      )
      .patch('/profiles/:id', params(idParam), ...json(renameProfileSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) => {
          renameProfile(db, c.req.valid('param').id, c.req.valid('json'));
          return c.json({ ok: true });
        }),
      )
      .patch('/accounts/:id', params(idParam), ...json(renameAccountSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) => {
          renameAccount(db, c.req.valid('param').id, c.req.valid('json'));
          return c.json({ ok: true });
        }),
      )
      // PRD §2 C5: the move and the account's recompute succeed or fail together.
      .post('/accounts/:id/move', params(idParam), ...json(moveAccountSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) => {
          const { id } = c.req.valid('param');
          const summary = moveAccount(db, id, c.req.valid('json'), (accountId) => recompute(db, accountId));
          return c.json({ moved: summary !== null, recomputed: summary?.positions ?? 0 });
        }),
      )
      .get('/vault/backups', (c) =>
        withBackups(live, host, (_, backups) => c.json({ backups: listBackups(backups.vaultPath) })),
      )
      .post('/vault/backup', (c) =>
        withBackups(live, host, (db, backups) =>
          c.json(manualBackup(db, backups.vaultPath, { appVersion: backups.appVersion }), 201),
        ),
      )
      .get('/vault/backups/:name', params(backupParam), (c) =>
        withBackups(live, host, (_, backups) => {
          const { name } = c.req.valid('param');
          const file = backupPath(backups.vaultPath, name);
          if (file === null) return error('not_found', 404);
          return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(statSync(file).size),
              'Content-Disposition': `attachment; filename="bhavbook-${name}"`,
            },
          });
        }),
      )
      .post('/vault/restore', ...json(restoreSchema, SMALL_JSON_BYTES), (c) =>
        withBackups(live, host, (_, backups) => {
          const file = backupPath(backups.vaultPath, c.req.valid('json').name);
          if (file === null) return error('not_found', 404);
          return restoreResponse(() => restoreListed(live, backups, file));
        }),
      )
      .post('/vault/restore/upload', ...upload(), async (c) => {
        if (live.db === null) live.recover?.();
        if (host === undefined || live.db === null) return error('no_vault', 503);
        // Streamed to disk, never buffered: a backup can be hundreds of megabytes.
        return restoreResponse(() => restoreUpload(live, host, c.req.raw.body));
      })
      .get('/imports', query(accountQuery), (c) =>
        withImports(imports, (service) =>
          c.json({ imports: service.history(c.req.valid('query').accountId) }),
        ),
      )
      // Preview: writes nothing; the reply's token commits exactly what was previewed, once, within 15 minutes.
      .post('/imports', ...multipart(), query(accountQuery), (c) =>
        withImports(imports, async (service) => {
          const files = await previewFiles(c);
          return jsonResponse(await service.previewImport(c.req.valid('query').accountId, files));
        }),
      )
      .post('/imports/commit', ...json(commitSchema, SMALL_JSON_BYTES), (c) =>
        withImports(imports, (service) => jsonResponse(service.commitImport(c.req.valid('json').token))),
      )
      .delete('/imports/:id', params(idParam), (c) =>
        withImports(imports, (service) => jsonResponse(service.undoImport(c.req.valid('param').id))),
      )
      .get('/coverage', query(accountQuery), (c) =>
        withImports(imports, (service) =>
          c.json({ coverage: service.coverage(c.req.valid('query').accountId) }),
        ),
      )
      .get('/issues', query(issueFilterSchema), (c) =>
        withVault(live, (db) => {
          const { issues, total } = listIssues(db, c.req.valid('query'));
          const instruments = instrumentNames(db, subjectKeys(issues.map((issue) => issue.subject)));
          return c.json({ issues, total, instruments });
        }),
      )
      .get('/issues/summary', (c) => withVault(live, (db) => c.json(issueSummary(db))))
      .post('/issues/:id/dismiss', params(idParam), (c) =>
        withAction(live, (db) => {
          dismissIssue(db, c.req.valid('param').id);
          return c.json({ ok: true });
        }),
      )
      .post('/issues/:id/reopen', params(idParam), (c) =>
        withAction(live, (db) => {
          reopenIssue(db, c.req.valid('param').id);
          return c.json({ ok: true });
        }),
      )
      // "Fill from broker statement": the suggested lot becomes an opening lot, and the account is recomputed.
      .post('/issues/:id/accept', params(idParam), (c) =>
        withAction(live, (db) =>
          c.json({ adjustmentId: acceptStatementSuggestion(db, c.req.valid('param').id) }),
        ),
      )
      // E7: real fills now cover an opening lot; the user replaces it.
      .post('/issues/:id/replace', params(idParam), (c) =>
        withAction(live, (db) => {
          replaceRedundantLot(db, c.req.valid('param').id);
          return c.json({ ok: true });
        }),
      )
      .get('/issues/:id/suggestions', params(idParam), (c) =>
        withAction(live, (db) => c.json({ suggestions: suggestionsForIssue(db, c.req.valid('param').id) })),
      )
      .post('/issues/:id/map', params(idParam), ...json(mapInstrumentSchema, SMALL_JSON_BYTES), (c) =>
        withAction(live, (db) => {
          mapIssueInstrument(db, c.req.valid('param').id, c.req.valid('json'));
          return c.json({ ok: true });
        }),
      )
      .post(
        '/accounts/:id/adjustments',
        params(idParam),
        ...json(adjustmentInputSchema, SMALL_JSON_BYTES),
        (c) =>
          withAction(live, (db) => {
            const id = applyAccountAdjustment(db, c.req.valid('param').id, c.req.valid('json'));
            return c.json({ id }, 201);
          }),
      )
      .post('/issues/:id/merge', params(idParam), ...json(mergeSchema, SMALL_JSON_BYTES), (c) =>
        withAction(live, (db) => {
          mergeCollision(db, c.req.valid('param').id, c.req.valid('json').intoId);
          return c.json({ ok: true });
        }),
      )
      .post('/adjustments/:id/revert', params(idParam), (c) =>
        withAction(live, (db) => {
          revertAndRecompute(db, c.req.valid('param').id);
          return c.json({ ok: true });
        }),
      )
      // Fixes are revertible both ways (ADR-0013).
      .post('/adjustments/:id/restore', params(idParam), (c) =>
        withAction(live, (db) => {
          restoreAndRecompute(db, c.req.valid('param').id);
          return c.json({ ok: true });
        }),
      )
      .get('/positions', query(positionsFilterSchema), (c) =>
        withVault(live, (db) => jsonResponse(listPositions(db, c.req.valid('query')))),
      )
      .get('/positions/review-count', query(reviewCountSchema), (c) =>
        withVault(live, (db) => c.json({ count: reviewQueueCount(db, c.req.valid('query')) })),
      )
      .get('/positions/:ref', params(refParam), (c) =>
        withAction(live, (db) => jsonResponse(positionDetail(db, c.req.valid('param').ref))),
      )
      .put(
        '/positions/:ref/journal',
        params(refParam),
        ...json(journalInputSchema, JOURNAL_JSON_BYTES),
        (c) =>
          withAction(live, (db) =>
            c.json({ id: saveJournal(db, c.req.valid('param').ref, c.req.valid('json')) }),
          ),
      )
      .post('/positions/:ref/review', params(refParam), (c) =>
        withAction(live, (db) => {
          setReviewed(db, c.req.valid('param').ref, true);
          return c.json({ ok: true });
        }),
      )
      .post('/journal/:id/attachments', params(idParam), ...webpUpload(), async (c) => {
        // Read first (within the body limit): the action itself is synchronous, so its errors map to codes.
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        return withAction(live, (db) =>
          c.json({ id: addAttachment(db, c.req.valid('param').id, bytes) }, 201),
        );
      })
      .get('/attachments/:id', params(idParam), (c) =>
        withAction(
          live,
          (db) =>
            new Response(readAttachment(db, c.req.valid('param').id), {
              headers: { 'Content-Type': 'image/webp' },
            }),
        ),
      )
      .delete('/attachments/:id', params(idParam), (c) =>
        withAction(live, (db) => {
          deleteAttachment(db, c.req.valid('param').id);
          return c.json({ ok: true });
        }),
      )
      .post('/positions/:ref/reopen', params(refParam), (c) =>
        withAction(live, (db) => {
          setReviewed(db, c.req.valid('param').ref, false);
          return c.json({ ok: true });
        }),
      )
      .get('/settings', (c) => withVault(live, (db) => c.json(readSettings(db))))
      .put('/settings', ...json(breakevenSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) => {
          setBreakeven(db, c.req.valid('json'));
          return c.json(readSettings(db));
        }),
      )
      .get('/tags', (c) => withVault(live, (db) => c.json({ tags: listTags(db) })))
      .post('/tags', ...json(tagInputSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) => c.json({ id: createTag(db, c.req.valid('json')) }, 201)),
      )
      .patch('/tags/:id', params(idParam), ...json(renameTagSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) => {
          renameTag(db, c.req.valid('param').id, c.req.valid('json'));
          return c.json({ ok: true });
        }),
      )
      .delete('/tags/:id', params(idParam), (c) =>
        withVault(live, (db) => c.json({ detached: deleteTag(db, c.req.valid('param').id) })),
      )
      .post('/tags/:id/merge', params(idParam), ...json(mergeTagSchema, SMALL_JSON_BYTES), (c) =>
        withVault(live, (db) =>
          c.json({ merged: mergeTag(db, c.req.valid('param').id, c.req.valid('json')) }),
        ),
      )
      .get('/analytics/summary', notImplemented)
  );
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
    // Build assets are content-hashed, so a successful one never changes: cache it. Everything else (the app shell,
    // the API) stays no-store.
    if (c.res.status === 200 && c.req.path.startsWith('/assets/')) {
      c.res.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
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
    // Client routes (`/settings`, `/positions/RELIANCE.NS`): the SPA's index.html. The API and missing build
    // assets (`/assets/...`, `/theme-init.js`-style root files) stay 404.
    app.get('*', async (c, next) => {
      const { path: requestPath } = c.req;
      const isApi = requestPath === '/api' || requestPath.startsWith('/api/');
      const isAsset =
        requestPath.startsWith('/assets/') || /^\/[^/]+\.(js|css|ico|png|svg|woff2?|map)$/.test(requestPath);
      if (isApi || isAsset) return error('not_found', 404);
      await next();
      return undefined;
    });
    app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));
    return;
  }
  app.get('/', (c: Context) => c.html(PLACEHOLDER_PAGE));
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  app.use('*', logAndHarden(options.logger));
  app.use('*', guard(options));
  app.route('/api', apiRoutes(options, liveVault(options.vault, options.backups)));
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
