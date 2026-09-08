import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  desktopFetch,
  getClientHeaders,
  withClientHeaders,
} from '../../src/main/infra/http/client';
import { version } from '../../package.json';
import {
  getApplicationLocale,
  setApplicationLocale,
} from '../../src/main/domains/i18n/application-locale';

describe('desktop request identity', () => {
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
    if (request.url === '/redirect') {
      response.writeHead(307, { Location: '/destination' });
    }
    response.end('ok');
  });
  let origin: string;
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });

  it.each([
    ['darwin', 'macOS'],
    ['win32', 'Windows'],
    ['linux', 'Linux'],
  ])(
    'matches Amical’s exact common header list and user-agent format on %s',
    (platform, displayName) => {
      expect(getClientHeaders({ appVersion: '1.2.3', platform, locale: 'ja' })).toEqual({
        'User-Agent': `prismical-desktop/1.2.3 (${displayName})`,
        'prismical-client': 'desktop',
        'prismical-version': '1.2.3',
        'prismical-platform': platform,
        'Accept-Language': 'ja',
      });
    }
  );

  it('uses the resolved application language on each request', () => {
    const original = getApplicationLocale();
    try {
      setApplicationLocale('ja');
      expect(getClientHeaders()['Accept-Language']).toBe('ja');
      setApplicationLocale('de');
      expect(getClientHeaders()['Accept-Language']).toBe('de');
    } finally {
      setApplicationLocale(original);
    }
  });

  it('keeps identity, auth, range, and Request bodies across a redirect', async () => {
    received.length = 0;
    const request = new Request(`${origin}/redirect`, {
      method: 'POST',
      body: 'payload',
      headers: { Authorization: 'Bearer test', Range: 'bytes=12-', 'Accept-Language': 'fr' },
    });
    expect(await (await desktopFetch(request)).text()).toBe('ok');
    expect(received).toHaveLength(2);
    for (const { headers, body } of received) {
      expect(headers).toMatchObject({
        'prismical-client': 'desktop',
        'prismical-version': version,
        'prismical-platform': process.platform,
        authorization: 'Bearer test',
        range: 'bytes=12-',
        'accept-language': getApplicationLocale(),
      });
      expect(headers['user-agent']).toContain(`prismical-desktop/${version}`);
      expect(headers['prismical-os-version']).toBeUndefined();
      expect(headers['prismical-arch']).toBeUndefined();
      expect(body).toBe('payload');
    }
    expect(request.headers.has('prismical-client')).toBe(false);
  });

  it('preserves automatic multipart boundaries and cancellation', async () => {
    received.length = 0;
    const body = new FormData();
    body.set('file', new Blob(['audio']), 'recording.wav');
    await desktopFetch(origin, { method: 'POST', body });
    expect(received[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(received[0].body).toContain('recording.wav');
    expect(received[0].body).toContain('audio');
    const controller = new AbortController();
    controller.abort();
    await expect(desktopFetch(origin, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('merges all header representations case-insensitively and replaces SDK user agents', () => {
    for (const input of [
      { 'USER-AGENT': 'ai-sdk/test', 'PRISMICAL-CLIENT': 'wrong', Authorization: 'Bearer test' },
      [
        ['USER-AGENT', 'ai-sdk/test'],
        ['PRISMICAL-CLIENT', 'wrong'],
        ['Authorization', 'Bearer test'],
      ],
      new Headers({
        'User-Agent': 'ai-sdk/test',
        'prismical-client': 'wrong',
        Authorization: 'Bearer test',
      }),
    ] as HeadersInit[]) {
      const headers = withClientHeaders(input);
      expect(headers['user-agent']).toContain(`prismical-desktop/${version}`);
      expect(headers['user-agent']).not.toContain('ai-sdk/test');
      expect(headers['prismical-client']).toBe('desktop');
      expect(headers.authorization).toBe('Bearer test');
      expect(withClientHeaders(headers)).toEqual(headers);
    }
  });
});
