import { afterEach, describe, expect, it } from 'vitest';
import { STREAM_PORT_WINDOW_MESSAGE, type OpenStreamResponse } from '@prismical/desktop-contracts';
import { openAskStream, portToReadableStream } from '../../src/renderer/main/stream';

/**
 * FIX 1 (stream termination) + FIX 3 (renderer leak/settle) regressions.
 * Node has ReadableStream/Response/TextEncoder globally; MessagePort and window
 * are faked with the exact DOM-ish surface the helper touches.
 */

// Fails fast (red) if the helper hangs, instead of stalling the whole run.
const withTimeout = <T>(p: Promise<T>, ms = 1000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('stream helper hung (timeout)')), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
};

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  started = false;
  closed = false;
  posted: unknown[] = [];
  start(): void {
    this.started = true;
  }
  close(): void {
    this.closed = true;
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  // Test drivers.
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  remoteClose(): void {
    this.onclose?.();
  }
}

const asPort = (port: FakePort): MessagePort => port as unknown as MessagePort;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const readToEnd = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await withTimeout(reader.read());
    if (done) return out;
    out += decoder.decode(value);
  }
};

describe('portToReadableStream (SSE bytes verbatim; terminal on done / abort / port close)', () => {
  it('forwards SSE bytes VERBATIM; the {type:done} marker closes the reader', async () => {
    const port = new FakePort();
    const { stream } = portToReadableStream(asPort(port));
    const reader = stream.getReader();

    // Main forwards raw SSE bytes — they arrive unchanged (no NDJSON framing).
    port.emit(bytes('data: {"type":"start"}\n\n'));
    const first = await withTimeout(reader.read());
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe('data: {"type":"start"}\n\n');

    port.emit(bytes('data: [DONE]\n\n'));
    // The terminal marker (a non-bytes message) settles the reader.
    port.emit({ type: 'done' });
    const rest = await readToEnd(reader); // must not hang
    expect(port.closed).toBe(true);
    expect(rest).toBe('data: [DONE]\n\n'); // the done marker itself is NOT enqueued
  });

  it('abort() settles a pending read (does NOT hang) and notifies main', async () => {
    const port = new FakePort();
    const { stream, abort } = portToReadableStream(asPort(port));
    const reader = stream.getReader();

    const pending = reader.read(); // nothing enqueued yet — would hang without the fix
    abort();
    const result = await withTimeout(pending);

    expect(result.done).toBe(true);
    expect(port.posted).toContainEqual({ type: 'abort' });
    expect(port.closed).toBe(true);
  });

  it('main-side port close without done settles the reader', async () => {
    const port = new FakePort();
    const { stream } = portToReadableStream(asPort(port));
    const reader = stream.getReader();

    const pending = reader.read();
    port.remoteClose(); // main closed the port without a {type:'done'}
    const result = await withTimeout(pending);

    expect(result.done).toBe(true);
  });
});

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

describe('openAskStream (FIX 3: failed open settles + no listener leak)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('rejected openStream removes the window listener and settles the promises', async () => {
    const win = new FakeWindow();
    let resolveOpened!: (r: OpenStreamResponse) => void;
    const opened = new Promise<OpenStreamResponse>(resolve => {
      resolveOpened = resolve;
    });
    win.desktop = { transport: { openStream: () => ({ streamId: 'sid', opened }) } };

    await withWindow(win, async () => {
      const handle = openAskStream({ method: 'POST', path: '/apps/v1/me/ask' });
      expect(win.listenerCount('message')).toBe(1);

      resolveOpened({ error: { code: 'PATH_NOT_ALLOWED' } });
      await expect(withTimeout(handle.response)).rejects.toThrow(/PATH_NOT_ALLOWED/);
      expect(win.listenerCount('message')).toBe(0); // no stranded 'message' listener

      // send/abort on a failed open are safe no-ops (no throw, no hang).
      handle.send({ type: 'resume', parts: [] });
      handle.abort();
    });
  });

  it('successful openStream forwards the port; abort() terminates the reader', async () => {
    const win = new FakeWindow();
    const opened = Promise.resolve<OpenStreamResponse>({ ok: true, streamId: 'sid' });
    win.desktop = { transport: { openStream: () => ({ streamId: 'sid', opened }) } };
    const port = new FakePort();

    await withWindow(win, async () => {
      const handle = openAskStream({ method: 'POST', path: '/apps/v1/me/ask' });
      expect(win.listenerCount('message')).toBe(1);

      win.dispatch('message', {
        data: { type: STREAM_PORT_WINDOW_MESSAGE, streamId: 'sid' },
        ports: [port],
      });
      expect(win.listenerCount('message')).toBe(0); // removed once the port arrived

      const response = await withTimeout(handle.response);
      // The shim marks the body as SSE so DefaultChatTransport parses it.
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.body).not.toBeNull();
      const reader = response.body!.getReader();

      port.emit(bytes('data: {"type":"text-delta","delta":"x"}\n\n'));
      const first = await withTimeout(reader.read());
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toBe('data: {"type":"text-delta","delta":"x"}\n\n');

      handle.abort();
      const after = await withTimeout(reader.read()); // reads AFTER abort must terminate
      expect(after.done).toBe(true);
      expect(port.posted).toContainEqual({ type: 'abort' });
    });
  });
});
