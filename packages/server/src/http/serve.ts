// The listener: always 127.0.0.1 (ADR-0001), a free port by default, and WebSocket upgrades held to the same
// Host/Origin/token check as HTTP (ADR-0002). No WebSocket route exists yet, so a valid upgrade gets 501.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { serve } from '@hono/node-server';
import { createApp, type AppOptions } from './app.js';
import { checkRequest, launchGate } from './security.js';

export const HOSTNAME = '127.0.0.1';

export interface StartOptions extends Omit<AppOptions, 'port' | 'launch'> {
  /** 0 (the default) picks a free port. */
  readonly port?: number;
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  /** The launch URL: opening it once sets the session cookie, then it is spent. */
  readonly url: string;
  close(): Promise<void>;
}

const REASONS: Readonly<Record<number, string>> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  501: 'Not Implemented',
};

function refuseUpgrade(socket: Duplex, status: 401 | 403 | 501): void {
  socket.end(
    `HTTP/1.1 ${String(status)} ${REASONS[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function handleUpgrade(request: IncomingMessage, socket: Duplex, port: number, token: string): void {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const facts = {
    method: request.method ?? 'GET',
    host: header('host'),
    origin: header('origin'),
    fetchSite: header('sec-fetch-site'),
    cookie: header('cookie'),
  };
  const result = checkRequest(facts, port, token);
  refuseUpgrade(socket, result.ok ? 501 : result.status);
}

const LAUNCH_TOKEN_BYTES = 32;

export async function startServer(options: StartOptions): Promise<RunningServer> {
  let port = 0;
  const launchToken = randomBytes(LAUNCH_TOKEN_BYTES).toString('base64url');
  const app = createApp({ ...options, launch: launchGate(launchToken), port: () => port });
  const server = await new Promise<Server>((resolve, reject) => {
    const created = serve({ fetch: app.fetch, port: options.port ?? 0, hostname: HOSTNAME }, () => {
      resolve(created);
    }) as Server;
    created.once('error', reject);
  });
  port = (server.address() as AddressInfo).port;
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    socket.on('error', () => socket.destroy());
    handleUpgrade(request, socket, port, options.token);
  });
  return {
    server,
    port,
    url: `http://${HOSTNAME}:${String(port)}/?t=${launchToken}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((cause) => {
          if (cause) reject(cause);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
