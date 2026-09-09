// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  appendAudioFrame,
  createAudioSession,
  listAudioSessions,
  listAudioChunks,
  queueAudioChunk,
  readAudioChunk,
  stopAudioSession,
  removeAudioSession,
  holdAudioCapture,
  audioCaptureLock,
} from './audio-outbox';
import { drainAudioSession } from './audio-outbox-drain';
import { ApiError } from '../api/client';
import { finalizeRecording } from '../api/transcription';
import type { AuthPort, RecordingPort } from '@prismical/app-contracts';
vi.mock('../api/transcription', () => ({ finalizeRecording: vi.fn(async () => ({})) }));
const owner = {
  ownerSub: 'user',
  ownerSessionKey: 'user',
  ownerOrgId: 'org',
  recordingId: 'rec',
  noteId: 'note',
};
const auth = {
  getSession: () => ({ activeSub: 'user' }),
  getTokenForSession: vi.fn(async () => 'token'),
} as unknown as AuthPort;
let held: Set<string>;
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(finalizeRecording)
    .mockReset()
    .mockResolvedValue({} as never);
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });
  held = new Set();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        name: string,
        _options: unknown,
        run: (lock: unknown) => Promise<unknown>
      ) => {
        if (held.has(name)) return run(null);
        held.add(name);
        try {
          return await run({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
});
async function captured() {
  await createAudioSession(owner);
  await appendAudioFrame('rec', new Float32Array([0.25, 0.5, -0.25, -0.5]));
}
const port = () => ({
  uploadTranscriptionChunk: vi.fn<RecordingPort['uploadTranscriptionChunk']>(async () => []),
});

describe('durable audio outbox', () => {
  it('bounds a stuck storage open and closes a late connection', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const req = { result: { close } } as unknown as IDBOpenDBRequest;
    vi.spyOn(indexedDB, 'open').mockReturnValue(req);
    const rejected = expect(listAudioSessions()).rejects.toThrow('Audio storage open timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    req.onsuccess?.call(req, new Event('success'));
    expect(close).toHaveBeenCalledOnce();
  });

  it('recovers an interrupted partial chunk without an in-memory picker', async () => {
    await captured();
    const transport = port();
    const result = await drainAudioSession('rec', auth, transport, { recoverInterrupted: true });
    expect(result.completed?.capturedSamples).toBe(4);
    expect(transport.uploadTranscriptionChunk).toHaveBeenCalledOnce();
    const wav = transport.uploadTranscriptionChunk.mock.calls[0]![1] as ArrayBuffer;
    expect(wav.byteLength).toBe(52);
    expect(finalizeRecording).toHaveBeenCalledWith(
      'rec',
      0.25,
      expect.objectContaining({ activeOrgId: 'org' })
    );
    expect(await listAudioSessions()).toEqual([]);
  });

  it('reads exact sample ranges across frames and does not duplicate a boundary', async () => {
    await captured();
    await appendAudioFrame('rec', new Float32Array([0.125, -0.125]));
    await queueAudioChunk('rec', 3);
    await stopAudioSession('rec', 1000);
    const chunks = await listAudioChunks('rec');
    expect(chunks.map(c => [c.chunkIndex, c.startSample, c.endSample])).toEqual([
      [0, 0, 3],
      [1, 3, 6],
    ]);
    const payloads = await Promise.all(chunks.map(readAudioChunk));
    expect(payloads.map(wav => [...new Int16Array(wav, 44)])).toEqual([
      [8191, 16383, -8192],
      [-16384, 4095, -4096],
    ]);
  });

  it.each([
    new Error('offline'),
    new ApiError('QUOTA', 'quota', 402),
    new ApiError('KEY', 'key', 422),
  ])('retains bytes after repeated failure: %s', async error => {
    await captured();
    await stopAudioSession('rec');
    const transport = port();
    transport.uploadTranscriptionChunk.mockRejectedValue(error);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await drainAudioSession('rec', auth, transport, { force: true })).pending).toBe(true);
    }
    expect(finalizeRecording).not.toHaveBeenCalled();
    expect(await listAudioSessions()).toHaveLength(1);
    const [chunk] = await listAudioChunks('rec');
    expect(chunk?.attempts).toBe(5);
    expect(await readAudioChunk(chunk!)).toHaveProperty('byteLength', 52);
    transport.uploadTranscriptionChunk.mockResolvedValue([]);
    await drainAudioSession('rec', auth, transport, { force: true });
    expect(transport.uploadTranscriptionChunk.mock.calls.map(call => call[2].chunkIndex)).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(await listAudioSessions()).toEqual([]);
  });

  it('does not finalize or recover another tab while capture is locked', async () => {
    const release = await holdAudioCapture('rec');
    await captured();
    const transport = port();
    await drainAudioSession('rec', auth, transport, { recoverInterrupted: true });
    expect(held.has(audioCaptureLock('rec'))).toBe(true);
    expect(transport.uploadTranscriptionChunk).not.toHaveBeenCalled();
    release();
  });

  it('does not read credentials or send another owner audio', async () => {
    await captured();
    const transport = port();
    const token = vi.fn();
    await drainAudioSession(
      'rec',
      {
        ...auth,
        getSession: () => ({ activeSub: 'other' }),
        getTokenForSession: token,
      } as unknown as AuthPort,
      transport,
      { recoverInterrupted: true }
    );
    expect(token).not.toHaveBeenCalled();
    expect(transport.uploadTranscriptionChunk).not.toHaveBeenCalled();
    expect((await listAudioSessions())[0]?.stoppedAt).toBeUndefined();
  });

  it('retries a lost Stop response without re-uploading acknowledged audio', async () => {
    await captured();
    await stopAudioSession('rec');
    vi.mocked(finalizeRecording).mockRejectedValueOnce(new Error('lost response'));
    const transport = port();
    expect((await drainAudioSession('rec', auth, transport)).pending).toBe(true);
    expect(await listAudioSessions()).toHaveLength(1);
    expect((await drainAudioSession('rec', auth, transport)).completed).toBeDefined();
    expect(transport.uploadTranscriptionChunk).toHaveBeenCalledOnce();
  });

  it('rolls back capture metadata when storage rejects a frame', async () => {
    await captured();
    // add() must atomically reject duplicate primary keys, including the metadata change.
    const { IDBObjectStore } = await import('fake-indexeddb');
    const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    await expect(appendAudioFrame('rec', new Float32Array([1]))).rejects.toThrow('Full');
    add.mockRestore();
    expect((await listAudioSessions())[0]?.capturedSamples).toBe(4);
    await removeAudioSession('rec');
    expect(await listAudioChunks('rec')).toEqual([]);
  });
});
