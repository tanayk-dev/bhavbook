import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_JSON_BYTES, toJson } from '../../src/http/index.js';
import { latestVersion, loadMigrations, openVault } from '../../src/vault/index.js';
import { withTempDir } from '../vault/helpers.js';
import { LAUNCH, send, testApp, TOKEN } from './helpers.js';

describe('route tree', () => {
  it('reports the vault schema version', async () => {
    await withTempDir(async (dir) => {
      const db = openVault(path.join(dir, 'vault.db'), { appVersion: 'test' });
      try {
        const response = await send(testApp({}, db), '/api/vault');
        expect(await response.json()).toEqual({ schemaVersion: latestVersion(loadMigrations()) });
      } finally {
        db.close();
      }
    });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const response = await send(testApp(), '/api/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});

describe('input validation', () => {
  it.each([['x'.repeat(65)], ['a%20b'], ['a%3Bb'], ['%E2%82%B9']])(
    'rejects the malformed id %s with 400',
    async (id) => {
      const response = await send(testApp(), `/api/issues/${id}/suggestions`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    },
  );

  it('rejects malformed JSON without echoing it', async () => {
    const response = await send(testApp(), '/api/positions/cG9z/journal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"MARKER-7f3a":',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('MARKER');
  });

  it('rejects a non-JSON content type on JSON routes', async () => {
    const response = await send(testApp(), '/api/positions/cG9z/journal', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(response.status).toBe(415);
  });

  it('rejects bodies over the size limit with 413', async () => {
    const response = await send(testApp(), '/api/positions/cG9z/journal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(MAX_JSON_BYTES) }),
    });
    expect(response.status).toBe(413);
  });
});

describe('logging and error policy (ADR-0019)', () => {
  it('never puts request bodies or error messages in logs or responses', async () => {
    const test = testApp();
    test.app.post('/api/test-boom', async (c) => {
      const body = await c.req.text();
      throw new Error(`failed while handling ${body}`);
    });
    const response = await send(test, '/api/test-boom', {
      method: 'POST',
      body: 'MARKER-91c2 PAN ABCDE1234F',
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
    expect(text).not.toContain('MARKER');
    expect(test.lines.join('\n')).not.toContain('MARKER');
    expect(test.lines.join('\n')).not.toContain('ABCDE1234F');
    expect(test.lines.some((line) => (JSON.parse(line) as { status?: number }).status === 500)).toBe(true);
  });

  it('logs requests as JSON lines without the query string, so the launch token never reaches the log', async () => {
    const test = testApp();
    await send(test, `/?t=${LAUNCH}`, { headers: { cookie: null } });
    await send(test, '/api/positions/cG9z?secret=MARKER-55');
    const log = test.lines.join('\n');
    expect(log).not.toContain(LAUNCH);
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('MARKER');
    const entry = JSON.parse(test.lines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      event: 'request',
      method: 'GET',
      path: '/api/positions/:ref',
      status: 503,
    });
    expect(Object.keys(entry).sort()).toEqual(['event', 'level', 'method', 'ms', 'path', 'status', 'time']);
  });

  it('logs the matched route pattern, not the raw path, for unmatched requests too', async () => {
    const test = testApp();
    await send(test, '/api/MARKER-path-segment');
    expect(test.lines.join('\n')).not.toContain('MARKER');
  });
});

describe('JSON serialisation', () => {
  it('writes every bigint (money in micro-rupees) as an exact decimal string', () => {
    expect(toJson({ priceMicro: 891_972_727n, big: [2n ** 70n, -5n], n: 1 })).toBe(
      '{"priceMicro":"891972727","big":["1180591620717411303424","-5"],"n":1}',
    );
  });
});

describe('static web build', () => {
  it('serves the web build when one exists', async () => {
    await withTempDir(async (dir) => {
      mkdirSync(path.join(dir, 'assets'));
      writeFileSync(path.join(dir, 'index.html'), '<p>web build</p>');
      writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
      const test = testApp({ staticRoot: dir });
      expect(await (await send(test, '/')).text()).toContain('web build');
      const asset = await send(test, '/assets/app.js');
      expect([asset.status, asset.headers.get('cache-control')]).toEqual([
        200,
        'private, max-age=31536000, immutable',
      ]);
      expect((await send(test, '/')).headers.get('cache-control')).toBe('no-store');
      expect((await send(test, '/assets/app.js', { headers: { cookie: null } })).status).toBe(401);
    });
  });

  it('serves index.html for client routes (deep links), never for API paths or missing assets', async () => {
    await withTempDir(async (dir) => {
      mkdirSync(path.join(dir, 'assets'));
      writeFileSync(path.join(dir, 'index.html'), '<p>web build</p>');
      const test = testApp({ staticRoot: dir });
      for (const route of ['/settings', '/positions/abc', '/positions/RELIANCE.NS', '/review']) {
        const response = await send(test, route);
        expect([route, response.status, await response.text()]).toEqual([route, 200, '<p>web build</p>']);
      }
      expect((await send(test, '/assets/missing.js')).status).toBe(404);
      expect((await send(test, '/api/nope')).status).toBe(404);
      expect((await send(test, '/api')).status).toBe(404);
      expect((await send(test, '/missing.js')).status).toBe(404);
      expect((await send(test, '/settings', { headers: { cookie: null } })).status).toBe(401);
    });
  });

  it('serves a placeholder page when there is no web build yet', async () => {
    const response = await send(testApp({ staticRoot: null }), '/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('BhavBook');
  });

  it('does not serve files outside the web build', async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, 'web');
      mkdirSync(root);
      writeFileSync(path.join(dir, 'secret.txt'), 'MARKER-secret');
      const test = testApp({ staticRoot: root });
      for (const target of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
        expect(await (await send(test, target)).text()).not.toContain('MARKER');
      }
    });
  });
});
