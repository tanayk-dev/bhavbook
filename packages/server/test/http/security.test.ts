// ADR-0002: every route needs the session token and passes the Host/Origin allowlist; there is no CORS.
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/http/index.js';
import { ORIGIN, PORT, send, testApp, TOKEN } from './helpers.js';

describe('session token', () => {
  it('rejects a request without the session cookie with 401', async () => {
    const response = await send(testApp(), '/api/health', { headers: { cookie: null } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong token, including one that is a prefix of the real one', async () => {
    for (const value of ['nope', TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const response = await send(testApp(), '/api/health', { headers: { cookie: `${SESSION_COOKIE}=${value}` } });
      expect(response.status).toBe(401);
    }
  });

  it('accepts the session cookie', async () => {
    const response = await send(testApp(), '/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('turns the launch URL token into an HttpOnly SameSite=Strict cookie and strips it from the URL', async () => {
    const response = await send(testApp(), `/?t=${TOKEN}`, { headers: { cookie: null } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('rejects a wrong launch token', async () => {
    const response = await send(testApp(), '/?t=wrong', { headers: { cookie: null } });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not accept the token as a query parameter on API routes', async () => {
    const response = await send(testApp(), `/api/health?t=${TOKEN}`, { headers: { cookie: null } });
    expect(response.status).toBe(401);
  });
});

describe('Host allowlist', () => {
  it.each(['evil.example', `evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, '127.0.0.1', `0.0.0.0:${PORT}`])(
    'rejects Host %s with 403 even with a valid token',
    async (host) => {
      const response = await send(testApp(), '/api/health', { headers: { host } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    },
  );

  it('rejects a request without a Host header', async () => {
    expect((await send(testApp(), '/api/health', { headers: { host: null } })).status).toBe(403);
  });

  it('accepts localhost on the same port', async () => {
    expect((await send(testApp(), '/api/health', { headers: { host: `localhost:${PORT}` } })).status).toBe(200);
  });

  it('checks Host before the token, so a rebinding page learns nothing', async () => {
    const response = await send(testApp(), '/api/health', { headers: { host: 'evil.example', cookie: null } });
    expect(response.status).toBe(403);
  });
});

describe('Origin allowlist and no CORS', () => {
  it.each(['http://evil.example', 'null', `https://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT + 1}`])(
    'rejects Origin %s with 403',
    async (origin) => {
      const response = await send(testApp(), '/api/health', { headers: { origin } });
      expect(response.status).toBe(403);
    },
  );

  it('accepts the app origin, on either loopback name', async () => {
    for (const origin of [ORIGIN, `http://localhost:${PORT}`]) {
      expect((await send(testApp(), '/api/health', { headers: { origin } })).status).toBe(200);
    }
  });

  it('never answers a CORS preflight', async () => {
    const response = await send(testApp(), '/api/health', {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('response headers', () => {
  it('sets the hardening headers on every response, including rejections', async () => {
    for (const response of [await send(testApp(), '/api/health'), await send(testApp(), '/api/health', { headers: { cookie: null } })]) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});
