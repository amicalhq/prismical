'use client';

import { encodeWavPcm16 } from './wav-encode';

export const AUDIO_DB_NAME = 'recording-audio-outbox-v1';
export const AUDIO_SAMPLE_RATE = 16_000;
const MAX_RECOVERY_CHUNK_SAMPLES = AUDIO_SAMPLE_RATE * 15;
export interface AudioOwner {
  ownerSub: string;
  ownerOrgId: string;
  ownerSessionKey: string;
}
export interface AudioSession extends AudioOwner {
  recordingId: string;
  noteId: string;
  capturedSamples: number;
  queuedSamples: number;
  nextChunkIndex: number;
  createdAt: number;
  lastFrameAt: number;
  stoppedAt?: number;
}
export interface AudioChunk {
  recordingId: string;
  chunkIndex: number;
  startSample: number;
  endSample: number;
  acknowledged: boolean;
  attempts: number;
  nextAttemptAt: number;
  error?: string;
  status?: number;
}
interface AudioFrame {
  recordingId: string;
  startSample: number;
  samples: Float32Array;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Audio storage request failed'));
  });
}

// No memory fallback: accepting capture without a durable store would silently lose audio.
async function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('Audio storage unavailable');
  const req = indexedDB.open(AUDIO_DB_NAME, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('sessions', { keyPath: 'recordingId' });
    req.result.createObjectStore('frames', { keyPath: ['recordingId', 'startSample'] });
    req.result.createObjectStore('chunks', { keyPath: ['recordingId', 'chunkIndex'] });
  };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // An open request cannot be cancelled; close it if the browser later completes it.
      req.onsuccess = () => req.result.close();
      reject(new Error('Audio storage open timed out'));
    }, 10_000);
    req.onsuccess = () => {
      clearTimeout(timeout);
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timeout);
      reject(req.error ?? new Error('Audio storage unavailable'));
    };
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  const db = await open();
  try {
    const tx = db.transaction(['sessions', 'frames', 'chunks'], mode, { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Audio storage transaction aborted'));
      tx.onerror = () => {}; // onabort is the authoritative transaction failure.
    });
    // Observe completion even if an individual request rejects first.
    void done.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(tx).then(async result => {
          await done;
          return result;
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Audio storage transaction timed out')),
            10_000
          );
        }),
      ]);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* It may already have aborted. */
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    db.close();
  }
}

const range = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
async function sessionIn(tx: IDBTransaction, id: string): Promise<AudioSession> {
  const row = await request<AudioSession | undefined>(tx.objectStore('sessions').get(id));
  if (!row) throw new Error('Audio recovery session missing');
  return row;
}

export async function createAudioSession(
  input: AudioOwner & { recordingId: string; noteId: string }
): Promise<void> {
  await transaction('readwrite', async tx => {
    await request(
      tx.objectStore('sessions').add({
        ...input,
        capturedSamples: 0,
        queuedSamples: 0,
        nextChunkIndex: 0,
        createdAt: Date.now(),
        lastFrameAt: Date.now(),
      } satisfies AudioSession)
    );
  });
  // Best effort protection from eviction; recording correctness does not depend on a grant.
  void navigator.storage?.persist?.().catch(() => {});
}

export async function listAudioSessions(): Promise<AudioSession[]> {
  return transaction('readonly', tx => request(tx.objectStore('sessions').getAll()));
}

export async function appendAudioFrame(id: string, samples: Float32Array): Promise<void> {
  if (samples.length === 0) return;
  await transaction('readwrite', async tx => {
    const row = await sessionIn(tx, id);
    if (row.stoppedAt !== undefined) throw new Error('Audio capture already stopped');
    await request(
      tx
        .objectStore('frames')
        .add({ recordingId: id, startSample: row.capturedSamples, samples } satisfies AudioFrame)
    );
    row.capturedSamples += samples.length;
    row.lastFrameAt = Date.now();
    await request(tx.objectStore('sessions').put(row));
  });
}

function newChunk(row: AudioSession, endSample: number): AudioChunk {
  const chunk: AudioChunk = {
    recordingId: row.recordingId,
    chunkIndex: row.nextChunkIndex++,
    startSample: row.queuedSamples,
    endSample,
    acknowledged: false,
    attempts: 0,
    nextAttemptAt: 0,
  };
  row.queuedSamples = endSample;
  return chunk;
}

export async function queueAudioChunk(id: string, sampleCount: number): Promise<void> {
  await transaction('readwrite', async tx => {
    const row = await sessionIn(tx, id);
    const end = row.queuedSamples + sampleCount;
    if (sampleCount <= 0 || end > row.capturedSamples)
      throw new Error('Audio chunk exceeds durable capture');
    await request(tx.objectStore('chunks').add(newChunk(row, end)));
    await request(tx.objectStore('sessions').put(row));
  });
}

/** Caller holds the capture lock. Includes a persisted partial chunk after tab/process loss. */
export async function stopAudioSession(id: string, endedAt?: number): Promise<AudioSession> {
  return transaction('readwrite', async tx => {
    const row = await sessionIn(tx, id);
    row.stoppedAt ??= endedAt ?? row.lastFrameAt;
    while (row.queuedSamples < row.capturedSamples) {
      await request(
        tx
          .objectStore('chunks')
          .add(
            newChunk(
              row,
              Math.min(row.capturedSamples, row.queuedSamples + MAX_RECOVERY_CHUNK_SAMPLES)
            )
          )
      );
    }
    await request(tx.objectStore('sessions').put(row));
    return row;
  });
}

export async function listAudioChunks(id: string): Promise<AudioChunk[]> {
  return transaction('readonly', tx => request(tx.objectStore('chunks').getAll(range(id))));
}

/** Read only this chunk's frames, including the frame straddling its start. */
export async function readAudioChunk(chunk: AudioChunk): Promise<ArrayBuffer> {
  const frames = await transaction('readonly', async tx => {
    const store = tx.objectStore('frames');
    const prior = await request(
      store.openCursor(
        IDBKeyRange.bound([chunk.recordingId, 0], [chunk.recordingId, chunk.startSample]),
        'prev'
      )
    );
    const start = (prior?.value as AudioFrame | undefined)?.startSample ?? chunk.startSample;
    return request<AudioFrame[]>(
      store.getAll(
        IDBKeyRange.bound(
          [chunk.recordingId, start],
          [chunk.recordingId, chunk.endSample],
          false,
          true
        )
      )
    );
  });
  const samples = new Float32Array(chunk.endSample - chunk.startSample);
  let cursor = chunk.startSample;
  for (const frame of frames) {
    const start = Math.max(chunk.startSample, frame.startSample);
    const end = Math.min(chunk.endSample, frame.startSample + frame.samples.length);
    if (start !== cursor || end < start) throw new Error('Durable audio has a gap');
    samples.set(
      frame.samples.subarray(start - frame.startSample, end - frame.startSample),
      start - chunk.startSample
    );
    cursor = end;
  }
  if (cursor !== chunk.endSample) throw new Error('Durable audio is incomplete');
  return encodeWavPcm16(samples, AUDIO_SAMPLE_RATE);
}

export async function updateAudioChunk(chunk: AudioChunk): Promise<void> {
  await transaction('readwrite', async tx => {
    await request(tx.objectStore('chunks').put(chunk));
  });
}

/** Only after every chunk and Stop have been acknowledged by the server. */
export async function removeAudioSession(id: string): Promise<void> {
  await transaction('readwrite', async tx => {
    await request(tx.objectStore('frames').delete(range(id)));
    await request(tx.objectStore('chunks').delete(range(id)));
    await request(tx.objectStore('sessions').delete(id));
  });
}

export const audioCaptureLock = (id: string) => `recording-audio-capture:${id}`;
export const audioUploadLock = (id: string) => `recording-audio-upload:${id}`;

/** Locks are released by the browser on tab/process death, not by an unreliable unload event. */
export async function holdAudioCapture(id: string): Promise<() => void> {
  if (!navigator.locks) throw new Error('Durable audio recovery requires browser locks');
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(audioCaptureLock(id), { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Recording is already capturing');
        await new Promise<void>(release => resolve(release));
      })
      .catch(reject);
  });
}
