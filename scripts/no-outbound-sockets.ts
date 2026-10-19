// Vitest setup for every project (plan invariant 5): any attempt to open a network connection to a non-loopback
// host fails the test. Patching net.Socket#connect covers net/tls connect, http(s).request and Node's fetch
// (undici connects through node:net); fetch itself is also wrapped so the failure names the URL's host.
import net from 'node:net';

export const NO_OUTBOUND_MARKER = Symbol.for('bhavbook.noOutboundSockets');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export class OutboundConnectionError extends Error {
  override readonly name = 'OutboundConnectionError';
  constructor(host: string) {
    super(`outbound network connection blocked in tests (host: ${host})`);
  }
}

/** The host a Socket#connect call targets, or null for an IPC path (pipe / unix socket). */
function targetHost(args: unknown[]): string | null {
  const [first, second] = args;
  if (Array.isArray(first)) return targetHost(first as unknown[]);
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === 'string') return null;
    return typeof options.host === 'string' ? options.host : 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return typeof second === 'string' ? second : 'localhost';
}

function install(): void {
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[NO_OUTBOUND_MARKER] === true) return;
  registry[NO_OUTBOUND_MARKER] = true;

  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound below with the socket as `this`
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const host = targetHost(args);
    if (host !== null && !isLoopbackHost(host)) throw new OutboundConnectionError(host);
    return connect.apply(this, args as Parameters<typeof connect>);
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!isLoopbackHost(host)) return Promise.reject(new OutboundConnectionError(host));
    return realFetch(input, init);
  };
}

install();
