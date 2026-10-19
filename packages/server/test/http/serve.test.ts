// The real listener: bound to 127.0.0.1 only, the launch flow over a socket, and WebSocket upgrades checked by the
// same rules as HTTP.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, SESSION_COOKIE, startServer, type RunningServer } from '../../src/http/index.js';

const TOKEN = 't'.repeat(43);
const running: RunningServer[] = [];

async function start(): Promise<RunningServer> {
  const server = await startServer({ token: TOKEN, logger: createLogger(() => undefined), vault: null, port: 0 });
  running.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

/** Sends a WebSocket upgrade request and resolves with the HTTP status the server answered with. */
function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        host: `127.0.0.1:${port}`,
        ...headers,
      },
    });
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.on('error', reject);
    request.end();
  });
}

describe('startServer', () => {
  it('binds to 127.0.0.1 on a free port and returns the tokened launch URL', async () => {
    const server = await start();
    const address = server.server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBe(server.port);
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?t=${TOKEN}`);
  });

  it('runs the launch flow over a real socket', async () => {
    const server = await start();
    const launch = await fetch(server.url, { redirect: 'manual' });
    expect(launch.status).toBe(302);
    const cookie = (launch.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toBe(`${SESSION_COOKIE}=${TOKEN}`);
    const health = await fetch(`http://127.0.0.1:${server.port}/api/health`, { headers: { cookie } });
    expect(health.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/health`)).status).toBe(401);
  });

  it('frees the port on close', async () => {
    const server = await start();
    await server.close();
    running.splice(running.indexOf(server), 1);
    await expect(fetch(`http://127.0.0.1:${server.port}/api/health`)).rejects.toThrow();
  });
});

describe('WebSocket upgrades', () => {
  it('rejects an upgrade with a foreign Origin (403)', async () => {
    const server = await start();
    const status = await upgradeStatus(server.port, {
      origin: 'http://evil.example',
      cookie: `${SESSION_COOKIE}=${TOKEN}`,
    });
    expect(status).toBe(403);
  });

  it('rejects an upgrade with a foreign Host (403) or without the token (401)', async () => {
    const server = await start();
    expect(await upgradeStatus(server.port, { host: 'evil.example', cookie: `${SESSION_COOKIE}=${TOKEN}` })).toBe(403);
    expect(await upgradeStatus(server.port, {})).toBe(401);
  });

  it('answers a valid upgrade with 501 while no WebSocket route exists', async () => {
    const server = await start();
    const status = await upgradeStatus(server.port, {
      origin: `http://127.0.0.1:${server.port}`,
      cookie: `${SESSION_COOKIE}=${TOKEN}`,
    });
    expect(status).toBe(501);
  });
});
