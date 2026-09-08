import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePostHogNodeSink } from '../../src/main/domains/telemetry/posthog-sink';
import { projectTelemetryException } from '../../src/shared/telemetry-exception';

afterEach(() => vi.unstubAllGlobals());

describe('PostHog SDK transport boundary', () => {
  it('sends safe exception frames with their originating renderer chunk IDs', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const sink = makePostHogNodeSink(
      'phc_test',
      'https://telemetry.test',
      () => true,
      () => {}
    );
    const chunk = 'ba4fcfa8-0c96-462c-819a-19877cdbd7cc';
    const error = projectTelemetryException(
      {
        name: 'TypeError',
        message: 'private content',
        frames: [
          {
            filename: '/Users/private/app/assets/main.js',
            lineno: 12,
            colno: 3,
            chunk_id: chunk,
            platform: 'web:javascript',
          },
        ],
      },
      'renderer'
    );
    sink.captureException(error, 'account-a', { runtime: 'renderer' });
    await sink.shutdown(2_000);
    expect(transport).toHaveBeenCalledOnce();
    const options = (transport.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = new Headers(options.headers);
    expect(headers.get('prismical-client')).toBe('desktop');
    expect(headers.get('user-agent')).toContain('prismical-desktop/');
    const body = JSON.parse(
      gunzipSync(Buffer.from(await new Response(options.body).arrayBuffer())).toString()
    );
    expect(body.batch[0].properties.$exception_list[0]).toMatchObject({
      type: 'TypeError',
      value: 'TypeError captured',
      stacktrace: {
        frames: [
          {
            filename: 'assets/main.js',
            lineno: 12,
            colno: 3,
            chunk_id: chunk,
            platform: 'web:javascript',
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('private');
  });
  it('flushes main and renderer events with explicit identities through the real SDK', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const sink = makePostHogNodeSink(
      'phc_test',
      'https://telemetry.test',
      () => true,
      () => {}
    );
    sink.capture({
      distinctId: 'account-a',
      event: 'recording_completed',
      properties: { runtime: 'renderer' },
      groups: { organization: 'org-a' },
    });
    await sink.shutdown(2_000);
    expect(transport).toHaveBeenCalledOnce();
    const options = (transport.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(
      gunzipSync(Buffer.from(await new Response(options.body).arrayBuffer())).toString()
    );
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]).toMatchObject({
      distinct_id: 'account-a',
      event: 'recording_completed',
      properties: { runtime: 'renderer', $groups: { organization: 'org-a' } },
    });
    expect(JSON.stringify(body)).not.toContain('$anon_distinct_id');
  });
  it('does not upload already queued events when authority turns off before flush', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', transport);
    let enabled = true;
    const sink = makePostHogNodeSink(
      'phc_test',
      'https://telemetry.test',
      () => enabled,
      () => {}
    );
    sink.capture({ distinctId: 'account-a', event: 'note_created' });
    await new Promise<void>(resolve => setImmediate(resolve));
    enabled = false;
    await sink.shutdown(2_000);
    expect(transport).not.toHaveBeenCalled();
  });
  it('discard permanently invalidates an old client even if telemetry is re-enabled', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const sink = makePostHogNodeSink(
      'phc_test',
      'https://telemetry.test',
      () => true,
      () => {}
    );
    sink.capture({ distinctId: 'account-a', event: 'note_created' });
    sink.discard();
    sink.capture({ distinctId: 'account-a', event: 'late_event' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
  });
  it('counts SDK evictions after asynchronous preparation of a burst', async () => {
    let firstIndex!: number;
    const transport = vi.fn(async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(
        gunzipSync(Buffer.from(await new Response(options.body).arrayBuffer())).toString()
      );
      firstIndex = body.batch[0].properties.index;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    });
    vi.stubGlobal('fetch', transport);
    const dropped = vi.fn();
    const sink = makePostHogNodeSink('phc_test', 'https://telemetry.test', () => true, dropped);
    try {
      for (let index = 0; index < 1100; index++)
        sink.capture({ distinctId: 'account-a', event: 'burst', properties: { index } });
      await vi.waitFor(() => expect(firstIndex).toBe(100));
    } finally {
      sink.discard();
    }
    expect(dropped.mock.calls.reduce((total, [count]) => total + count, 0)).toBe(100);
  });
});
