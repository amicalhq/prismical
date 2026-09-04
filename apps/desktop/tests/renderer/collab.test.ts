import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLLAB_PORT_WINDOW_MESSAGE, type CollabOpenResponse } from '@prismical/desktop-contracts';
import { openNoteLog } from '../../src/renderer/main/collab';

/**
 * Renderer half of the note-body log lane: port matching by openId,
 * pre-subscribe update buffering, the hydrated promise, structured outbound
 * messages, failed-open settling (no listener leak), and close. MessagePort +
 * window are faked with the exact DOM-ish surface the helper touches
 * (tests/renderer/stream.test.ts idiom).
 */

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  started = false;
  closed = false;
  posted: unknown[] = [];
  /** How many messages had been delivered when close() ran (FIFO ordering pin). */
  postsAtClose: number | null = null;
  start(): void {
    this.started = true;
  }
  close(): void {
    this.closed = true;
    this.postsAtClose = this.posted.length;
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  // Test driver.
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

class FakeWindow {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  desktop: unknown;
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const withWindow = async (win: FakeWindow, body: () => Promise<void>): Promise<void> => {
  const holder = globalThis as { window?: unknown };
  const previous = holder.window;
  holder.window = win as unknown as Window;
  try {
    await body();
  } finally {
    holder.window = previous;
  }
};

const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const winWithOpen = (opened: Promise<CollabOpenResponse>): FakeWindow => {
  const win = new FakeWindow();
  win.desktop = { collab: { open: () => ({ openId: 'oid', opened }) } };
  return win;
};

describe('openNoteLog renderer bridge', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('failed open removes the window listener; sends become safe no-ops', async () => {
    const win = winWithOpen(Promise.resolve({ error: { code: 'NO_WORKSPACE' } }));
    await withWindow(win, async () => {
      const handle = openNoteLog('nt_1');
      expect(win.listenerCount('message')).toBe(1);
      await expect(handle.opened).resolves.toEqual({ error: { code: 'NO_WORKSPACE' } });
      await flushMicrotasks();
      expect(win.listenerCount('message')).toBe(0); // no stranded 'message' listener
      // No port will ever arrive — outbound calls must not throw or hang.
      handle.sendUpdate(Uint8Array.from([1]));
      handle.flush({ text: 'a', markdown: null, firstLine: 'a' });
      handle.close();
    });
  });

  it('buffers replayed updates until onUpdate subscribes; hydrated resolves with seq/count', async () => {
    const win = winWithOpen(Promise.resolve({ ok: true }));
    const port = new FakePort();
    await withWindow(win, async () => {
      const handle = openNoteLog('nt_1');
      win.dispatch('message', {
        data: { type: COLLAB_PORT_WINDOW_MESSAGE, openId: 'oid' },
        ports: [port],
      });
      expect(win.listenerCount('message')).toBe(0); // removed once the port arrived
      await flushMicrotasks();
      expect(port.started).toBe(true);

      // Replay lands BEFORE the consumer subscribes — buffered, then drained.
      port.emit({ type: 'update', data: Uint8Array.from([1]) });
      port.emit({ type: 'update', data: Uint8Array.from([2]) });
      port.emit({ type: 'hydrated', seq: 2, count: 2 });
      const seen: Uint8Array[] = [];
      handle.onUpdate(update => seen.push(update));
      expect(seen).toEqual([Uint8Array.from([1]), Uint8Array.from([2])]);
      await expect(handle.hydrated).resolves.toEqual({ seq: 2, count: 2 });

      // A live relay after subscription delivers directly.
      port.emit({ type: 'update', data: Uint8Array.from([3]) });
      expect(seen).toHaveLength(3);
    });
  });

  it('non-conforming inbound messages are ignored — never delivered, never terminal', async () => {
    const win = winWithOpen(Promise.resolve({ ok: true }));
    const port = new FakePort();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await withWindow(win, async () => {
        const handle = openNoteLog('nt_1');
        win.dispatch('message', {
          data: { type: COLLAB_PORT_WINDOW_MESSAGE, openId: 'oid' },
          ports: [port],
        });
        await flushMicrotasks();
        const seen: Uint8Array[] = [];
        handle.onUpdate(update => seen.push(update));

        port.emit({ type: 'done' });
        port.emit({ type: 'update', data: 'not-bytes' });
        port.emit('bytes?');
        expect(seen).toHaveLength(0);
        expect(warn).toHaveBeenCalled();

        // The lane is still live after garbage.
        port.emit({ type: 'update', data: Uint8Array.from([9]) });
        expect(seen).toHaveLength(1);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('sendUpdate/flush/compact post the collab vocabulary; close closes the port', async () => {
    const win = winWithOpen(Promise.resolve({ ok: true }));
    const port = new FakePort();
    await withWindow(win, async () => {
      const handle = openNoteLog('nt_1');
      win.dispatch('message', {
        data: { type: COLLAB_PORT_WINDOW_MESSAGE, openId: 'oid' },
        ports: [port],
      });
      await flushMicrotasks();

      handle.sendUpdate(Uint8Array.from([7]));
      handle.flush({ text: 'body', markdown: '# body', firstLine: 'body' });
      handle.compact(4, Uint8Array.from([9]));
      await flushMicrotasks();
      expect(port.posted).toEqual([
        { type: 'update', data: Uint8Array.from([7]) },
        { type: 'flush', text: 'body', markdown: '# body', firstLine: 'body' },
        { type: 'compact', upTo: 4, state: Uint8Array.from([9]) },
      ]);

      handle.close();
      await flushMicrotasks();
      expect(port.closed).toBe(true);
      // Posts after close are dropped.
      handle.sendUpdate(Uint8Array.from([8]));
      await flushMicrotasks();
      expect(port.posted).toHaveLength(3);
    });
  });

  it('a flush posted immediately before close() is still delivered', async () => {
    const win = winWithOpen(Promise.resolve({ ok: true }));
    const port = new FakePort();
    await withWindow(win, async () => {
      const handle = openNoteLog('nt_1');
      win.dispatch('message', {
        data: { type: COLLAB_PORT_WINDOW_MESSAGE, openId: 'oid' },
        ports: [port],
      });
      await flushMicrotasks();

      // Exactly use-note-collab's unmount: final flush, then close, same tick.
      handle.flush({ text: 'Q4 planning', markdown: null, firstLine: 'Q4 planning' });
      handle.close();
      await flushMicrotasks();

      expect(port.posted).toEqual([
        { type: 'flush', text: 'Q4 planning', markdown: null, firstLine: 'Q4 planning' },
      ]);
      // …and the port closed BEHIND it, not before.
      expect(port.postsAtClose).toBe(1);
    });
  });

  it('dispatches the resync arm to onResync', async () => {
    const win = winWithOpen(Promise.resolve({ ok: true }));
    const port = new FakePort();
    await withWindow(win, async () => {
      const handle = openNoteLog('nt_1');
      win.dispatch('message', {
        data: { type: COLLAB_PORT_WINDOW_MESSAGE, openId: 'oid' },
        ports: [port],
      });
      await flushMicrotasks();

      let resyncs = 0;
      handle.onResync(() => {
        resyncs += 1;
      });
      port.emit({ type: 'resync' });
      port.emit({ type: 'resync' });
      expect(resyncs).toBe(2);
    });
  });

  it('ignores port messages for other openIds', async () => {
    const win = winWithOpen(Promise.resolve({ ok: true }));
    const port = new FakePort();
    await withWindow(win, async () => {
      openNoteLog('nt_1');
      win.dispatch('message', {
        data: { type: COLLAB_PORT_WINDOW_MESSAGE, openId: 'someone-else' },
        ports: [port],
      });
      expect(win.listenerCount('message')).toBe(1); // still waiting for OUR port
    });
  });
});
