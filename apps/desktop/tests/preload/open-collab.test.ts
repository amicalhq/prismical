import { describe, expect, it, vi } from 'vitest';
import { collabPortChannel, type CollabOpenResponse } from '@prismical/desktop-contracts';
import {
  makeOpenCollab,
  type OpenCollabIpc,
  type CollabPortEvent,
} from '../../src/preload/open-collab';

const makeIpc = () => {
  const listeners = new Map<string, Set<(event: CollabPortEvent) => void>>();
  let resolveInvoke!: (r: CollabOpenResponse) => void;
  let rejectInvoke!: (e: unknown) => void;
  const invokes: Array<{ channel: string; payload: unknown }> = [];
  const invokePromise = new Promise<CollabOpenResponse>((res, rej) => {
    resolveInvoke = res;
    rejectInvoke = rej;
  });
  const ipc: OpenCollabIpc = {
    once: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener);
    },
    invoke: (channel, payload) => {
      invokes.push({ channel, payload });
      return invokePromise;
    },
  };
  return {
    ipc,
    invokes,
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    firePort: (channel: string, event: CollabPortEvent) => {
      const set = listeners.get(channel);
      if (!set) return;
      for (const l of [...set]) l(event);
      set.clear(); // model ipcRenderer.once auto-removal on fire
    },
    resolveInvoke: (r: CollabOpenResponse) => resolveInvoke(r),
    rejectInvoke: (e: unknown) => rejectInvoke(e),
  };
};

describe('openCollab (preload)', () => {
  it('drops the stranded port listener on an error envelope', async () => {
    const h = makeIpc();
    const forwardPort = vi.fn();
    const openCollab = makeOpenCollab(h.ipc, { randomUUID: () => 'uuid-err', forwardPort });
    const handle = openCollab('nt_1');
    const channel = collabPortChannel('uuid-err');

    expect(h.listenerCount(channel)).toBe(1); // registered before the invoke resolves
    expect(h.invokes).toEqual([{ channel: 'collab:open', payload: { openId: 'uuid-err', noteId: 'nt_1' } }]);
    h.resolveInvoke({ error: { code: 'NO_WORKSPACE' } });
    const response = await handle.opened;

    expect(response).toEqual({ error: { code: 'NO_WORKSPACE' } });
    expect(h.listenerCount(channel)).toBe(0); // back to baseline — no leak
    expect(forwardPort).not.toHaveBeenCalled();
  });

  it('drops the port listener when the invoke itself rejects', async () => {
    const h = makeIpc();
    const openCollab = makeOpenCollab(h.ipc, {
      randomUUID: () => 'uuid-rej',
      forwardPort: () => undefined,
    });
    const handle = openCollab('nt_1');
    const channel = collabPortChannel('uuid-rej');

    expect(h.listenerCount(channel)).toBe(1);
    h.rejectInvoke(new Error('ipc down'));
    await expect(handle.opened).rejects.toThrow('ipc down');
    expect(h.listenerCount(channel)).toBe(0);
  });

  it('forwards the transferred port on success (and once auto-removes)', async () => {
    const h = makeIpc();
    const forwardPort = vi.fn();
    const openCollab = makeOpenCollab(h.ipc, { randomUUID: () => 'uuid-ok', forwardPort });
    const handle = openCollab('nt_1');
    const channel = collabPortChannel('uuid-ok');

    const fakePort = {} as MessagePort;
    h.firePort(channel, { ports: [fakePort] });
    expect(forwardPort).toHaveBeenCalledWith('uuid-ok', [fakePort]);

    h.resolveInvoke({ ok: true });
    await expect(handle.opened).resolves.toEqual({ ok: true });
    expect(handle.openId).toBe('uuid-ok');
    expect(h.listenerCount(channel)).toBe(0); // once auto-removed on fire
  });
});
