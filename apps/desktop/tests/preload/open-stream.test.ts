import { describe, expect, it, vi } from 'vitest';
import { streamPortChannel, type OpenStreamResponse } from '@prismical/desktop-contracts';
import {
  makeOpenStream,
  type OpenStreamIpc,
  type StreamPortEvent,
} from '../../src/preload/open-stream';

const makeIpc = () => {
  const listeners = new Map<string, Set<(event: StreamPortEvent) => void>>();
  let resolveInvoke!: (r: OpenStreamResponse) => void;
  let rejectInvoke!: (e: unknown) => void;
  const invokePromise = new Promise<OpenStreamResponse>((res, rej) => {
    resolveInvoke = res;
    rejectInvoke = rej;
  });
  const ipc: OpenStreamIpc = {
    once: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener);
    },
    invoke: () => invokePromise,
  };
  return {
    ipc,
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    firePort: (channel: string, event: StreamPortEvent) => {
      const set = listeners.get(channel);
      if (!set) return;
      for (const l of [...set]) l(event);
      set.clear(); // model ipcRenderer.once auto-removal on fire
    },
    resolveInvoke: (r: OpenStreamResponse) => resolveInvoke(r),
    rejectInvoke: (e: unknown) => rejectInvoke(e),
  };
};

describe('openStream (preload)', () => {
  it('drops the stranded port listener on an error envelope', async () => {
    const h = makeIpc();
    const forwardPort = vi.fn();
    const openStream = makeOpenStream(h.ipc, { randomUUID: () => 'uuid-err', forwardPort });
    const handle = openStream({ method: 'POST', path: '/apps/v1/me/ask' });
    const channel = streamPortChannel('uuid-err');

    expect(h.listenerCount(channel)).toBe(1); // registered before the invoke resolves
    h.resolveInvoke({ error: { code: 'PATH_NOT_ALLOWED' } });
    const response = await handle.opened;

    expect(response).toEqual({ error: { code: 'PATH_NOT_ALLOWED' } });
    expect(h.listenerCount(channel)).toBe(0); // back to baseline — no leak
    expect(forwardPort).not.toHaveBeenCalled();
  });

  it('drops the port listener when the invoke itself rejects', async () => {
    const h = makeIpc();
    const openStream = makeOpenStream(h.ipc, {
      randomUUID: () => 'uuid-rej',
      forwardPort: () => undefined,
    });
    const handle = openStream({ method: 'POST', path: '/apps/v1/me/ask' });
    const channel = streamPortChannel('uuid-rej');

    expect(h.listenerCount(channel)).toBe(1);
    h.rejectInvoke(new Error('ipc down'));
    await expect(handle.opened).rejects.toThrow('ipc down');
    expect(h.listenerCount(channel)).toBe(0);
  });

  it('forwards the transferred port on success (and once auto-removes)', async () => {
    const h = makeIpc();
    const forwardPort = vi.fn();
    const openStream = makeOpenStream(h.ipc, { randomUUID: () => 'uuid-ok', forwardPort });
    const handle = openStream({ method: 'POST', path: '/apps/v1/me/ask' });
    const channel = streamPortChannel('uuid-ok');

    const fakePort = {} as MessagePort;
    h.firePort(channel, { ports: [fakePort] }); // main posts the port during the handler
    h.resolveInvoke({ ok: true, streamId: 'uuid-ok' });
    const response = await handle.opened;

    expect(response).toEqual({ ok: true, streamId: 'uuid-ok' });
    expect(forwardPort).toHaveBeenCalledWith('uuid-ok', [fakePort]);
    expect(h.listenerCount(channel)).toBe(0);
  });
});
