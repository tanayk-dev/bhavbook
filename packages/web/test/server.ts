// A stubbed BhavBook server for component and route tests: fetch answers by method and path.
import { vi } from 'vitest';

export interface Reply {
  readonly status?: number;
  readonly body: unknown;
}

export type Routes = Readonly<Record<string, Reply | ((body: unknown) => Reply)>>;

/** Stubs fetch; keys are `GET /api/vault`-style. Unknown routes answer 404 like the real server. */
export function stubServer(routes: Routes) {
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://127.0.0.1');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const route = routes[`${method} ${url.pathname}`];
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const reply =
      typeof route === 'function' ? route(body) : (route ?? { status: 404, body: { error: 'not_found' } });
    return Promise.resolve(Response.json(reply.body, { status: reply.status ?? 200 }));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
