import { describe, expect, it, vi } from 'vitest';
import {
  CHANNELS,
  fileUploadPortChannel,
  type FileUploadStartRequest,
  type FileUploadStartResponse,
} from '@prismical/desktop-contracts';
import { makeFileUpload, type FileUploadIpc } from '../../src/preload/file-upload';
import type { StreamPortEvent } from '../../src/preload/open-stream';

const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL = fileUploadPortChannel(UPLOAD_ID);
const REQUEST = {
  url: 'https://storage.test/upload',
  file: new File(['audio'], 'audio.wav'),
  contentType: 'audio/wav',
};

const makeIpc = () => {
  const listeners = new Map<string, Set<(event: StreamPortEvent) => void>>();
  const invokes: Array<{ channel: string; payload: FileUploadStartRequest }> = [];
  let answer!: { resolve: (r: FileUploadStartResponse) => void; reject: (e: unknown) => void };
  const ipc: FileUploadIpc = {
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
      return new Promise((resolve, reject) => {
        answer = { resolve, reject };
      });
    },
  };
  return {
    ipc,
    invokes,
    answer: () => answer,
    listenerCount: () => listeners.get(CHANNEL)?.size ?? 0,
    /** Main's side: post the port, then return the peer main writes to. */
    firePort: () => {
      const { port1, port2 } = new MessageChannel();
      for (const listener of listeners.get(CHANNEL) ?? []) listener({ ports: [port2] });
      listeners.get(CHANNEL)?.clear();
      return port1;
    },
  };
};

const deps = (path = '/picked/audio.wav') => ({
  randomUUID: () => UPLOAD_ID,
  getPathForFile: vi.fn(() => path),
});

/** The next message the preload sends back to main. */
const nextMessage = (port: MessagePort) =>
  new Promise<unknown>(resolve => {
    port.onmessage = event => resolve(event.data);
  });

describe('fileUpload (preload)', () => {
  it('sends the picked file path, forwards progress, and resolves with the result', async () => {
    const h = makeIpc();
    const d = deps();
    const onProgress = vi.fn();
    const upload = makeFileUpload(h.ipc, d)(REQUEST, onProgress);

    expect(d.getPathForFile).toHaveBeenCalledWith(REQUEST.file);
    expect(h.invokes).toEqual([
      {
        channel: CHANNELS.fileUploadStart,
        payload: {
          uploadId: UPLOAD_ID,
          url: REQUEST.url,
          filePath: '/picked/audio.wav',
          contentType: 'audio/wav',
        },
      },
    ]);
    const main = h.firePort();
    h.answer().resolve({ ok: true });
    main.postMessage({ type: 'progress', percent: 40 });
    main.postMessage({ type: 'done', result: { ok: true } });

    await expect(upload.done).resolves.toEqual({ ok: true });
    expect(onProgress).toHaveBeenCalledWith(40);
    main.close();
  });

  it('rejects a file with no disk path without asking main', async () => {
    const h = makeIpc();
    const upload = makeFileUpload(h.ipc, deps(''))(REQUEST, vi.fn());
    await expect(upload.done).resolves.toEqual({ ok: false, reason: 'rejected' });
    expect(h.invokes).toHaveLength(0);
    expect(h.listenerCount()).toBe(0);
  });

  it.each([
    ['an error envelope', 'resolve', 'rejected'],
    ['a failed invoke', 'reject', 'interrupted'],
  ] as const)('settles %s as %s and drops the port listener', async (_name, how, reason) => {
    const h = makeIpc();
    const upload = makeFileUpload(h.ipc, deps())(REQUEST, vi.fn());
    expect(h.listenerCount()).toBe(1);
    if (how === 'resolve') h.answer().resolve({ error: { code: 'NOT_GRANTED' } });
    else h.answer().reject(new Error('ipc gone'));
    await expect(upload.done).resolves.toEqual({ ok: false, reason });
    expect(h.listenerCount()).toBe(0);
  });

  it.each([
    ['before', true],
    ['after', false],
  ])('sends cancel on the port when cancel comes %s the port', async (_when, early) => {
    const h = makeIpc();
    const upload = makeFileUpload(h.ipc, deps())(REQUEST, vi.fn());
    if (early) upload.cancel();
    const main = h.firePort();
    const received = nextMessage(main);
    if (!early) upload.cancel();
    await expect(received).resolves.toEqual({ type: 'cancel' });
    main.postMessage({ type: 'done', result: { ok: false, reason: 'cancelled' } });
    await expect(upload.done).resolves.toEqual({ ok: false, reason: 'cancelled' });
    main.close();
  });
});
