// Plan invariant 5: the global test setup blocks every non-loopback connection, whichever API opens it.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { isLoopbackHost, OutboundConnectionError } from '../../../scripts/no-outbound-sockets.js';

describe('no-outbound-sockets', () => {
  it('blocks net.connect and tls.connect to a public host', () => {
    expect(() => net.connect(80, 'example.com')).toThrow(OutboundConnectionError);
    expect(() => net.connect({ host: '93.184.215.14', port: 443 })).toThrow(OutboundConnectionError);
    expect(() => tls.connect({ host: 'example.com', port: 443 })).toThrow(OutboundConnectionError);
  });

  it('blocks http.request and https.request', () => {
    expect(() => http.request('http://example.com/').end()).toThrow(OutboundConnectionError);
    expect(() => https.get('https://example.com/')).toThrow(OutboundConnectionError);
  });

  it('blocks fetch', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow(OutboundConnectionError);
  });

  it('allows loopback', async () => {
    const server = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('classifies hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '127.8.9.10', '::1', 'LOCALHOST'])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['example.com', '10.0.0.1', '0.0.0.0', '127.0.0.1.evil.example', ''])
      expect(isLoopbackHost(host)).toBe(false);
  });
});
