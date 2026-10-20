// S11 review follow-ups: same-site requests from other localhost ports, unsafe methods without Origin, per-port
// cookies, HTTPException statuses, and dotfiles in the web build.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { sessionCookieName } from '../../src/http/index.js';
import { withTempDir } from '../vault/helpers.js';
import { ORIGIN, PORT, send, testApp, TOKEN } from './helpers.js';

describe('fetch metadata and unsafe methods', () => {
  it.each(['cross-site', 'same-site'])(
    'rejects Sec-Fetch-Site: %s (another localhost port) with 403',
    async (site) => {
      const response = await send(testApp(), '/api/health', { headers: { 'sec-fetch-site': site } });
      expect(response.status).toBe(403);
    },
  );

  it.each(['same-origin', 'none'])('accepts Sec-Fetch-Site: %s', async (site) => {
    expect((await send(testApp(), '/api/health', { headers: { 'sec-fetch-site': site } })).status).toBe(200);
  });

  it('rejects a state-changing request without an Origin header', async () => {
    const response = await send(testApp(), '/api/issues/x/resolve', {
      method: 'POST',
      headers: { origin: null },
    });
    expect(response.status).toBe(403);
    expect(
      (await send(testApp(), '/api/issues/x/resolve', { method: 'POST', headers: { origin: ORIGIN } }))
        .status,
    ).toBe(501);
  });

  it('names the session cookie per port, so two instances and other localhost apps do not collide', async () => {
    expect(sessionCookieName(PORT)).toBe(`bhavbook_session_${PORT}`);
    const launch = await send(testApp(), `/?t=${TOKEN}`, { headers: { cookie: null } });
    expect(launch.headers.get('set-cookie')).toContain(`bhavbook_session_${PORT}=`);
    const other = await send(testApp(), '/api/health', {
      headers: { cookie: `bhavbook_session_${PORT + 1}=${TOKEN}` },
    });
    expect(other.status).toBe(401);
  });
});

describe('error statuses', () => {
  it('keeps the status of an HTTPException below 500, with a fixed body', async () => {
    const test = testApp();
    test.app.get('/api/test-413', () => {
      throw new HTTPException(413, { message: 'MARKER-too-big' });
    });
    const response = await send(test, '/api/test-413');
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain('MARKER');
  });

  it('logs a non-Error throw without crashing', async () => {
    const test = testApp();
    test.app.get('/api/test-throw', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
      throw 'MARKER-string';
    });
    expect((await send(test, '/api/test-throw')).status).toBe(500);
    expect(test.lines.join('\n')).not.toContain('MARKER');
  });
});

describe('web build', () => {
  it('does not serve dotfiles or dot-directories', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(path.join(dir, 'index.html'), 'ok');
      writeFileSync(path.join(dir, '.env'), 'MARKER-env');
      mkdirSync(path.join(dir, '.git'));
      writeFileSync(path.join(dir, '.git', 'config'), 'MARKER-git');
      const test = testApp({ staticRoot: dir });
      for (const target of ['/.env', '/.git/config', '/%2eenv']) {
        const response = await send(test, target);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('MARKER');
      }
    });
  });
});
