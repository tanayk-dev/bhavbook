// Shared helpers for HTTP tests: an in-memory app with a captured log, and requests that pass the checks by default.
import type Database from 'better-sqlite3';
import { createApp, createLogger, sessionCookieName, type AppOptions } from '../../src/http/index.js';

export const TOKEN = 'k'.repeat(43);
export const PORT = 4321;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly lines: string[];
}

export function testApp(overrides: Partial<AppOptions> = {}, db: Database.Database | null = null): TestApp {
  const lines: string[] = [];
  const app = createApp({
    token: TOKEN,
    port: () => PORT,
    logger: createLogger((line) => lines.push(line)),
    vault: db,
    ...overrides,
  });
  return { app, lines };
}

export interface RequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string | null>;
  readonly body?: string | Uint8Array | undefined;
}

/** A request with a valid Host, Origin and session cookie unless a test overrides them (null removes one). */
export async function send(test: TestApp, target: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers();
  const defaults: Record<string, string | null> = {
    host: `127.0.0.1:${PORT}`,
    cookie: `${sessionCookieName(PORT)}=${TOKEN}`,
    origin: ORIGIN,
    ...options.headers,
  };
  for (const [name, value] of Object.entries(defaults)) if (value !== null) headers.set(name, value);
  return test.app.request(`http://127.0.0.1:${PORT}${target}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}
