import type { AuthPort, RecordingPort, RecordingTranscriptSegment } from '@prismical/app-contracts';
import { ApiError } from '../api/client';
import { finalizeRecording } from '../api/transcription';
import {
  AUDIO_SAMPLE_RATE,
  audioCaptureLock,
  audioUploadLock,
  listAudioChunks,
  listAudioSessions,
  readAudioChunk,
  removeAudioSession,
  stopAudioSession,
  updateAudioChunk,
  type AudioSession,
} from './audio-outbox';

export interface AudioDrainResult {
  recordingId: string;
  pending: boolean;
  /** Pending because delivery failed/offline, rather than another sender still working. */
  retrying?: boolean;
  completed?: AudioSession;
  segments: RecordingTranscriptSegment[];
  error?: unknown;
}

function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof ApiError) {
    const hint = (error.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
    if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0)
      return Math.min(hint, 300_000);
    // Preserve user-fixable errors as well as outages. No attempt limit deletes captured audio.
    if (error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status))
      return 60_000;
  }
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6));
}

export async function drainAudioSession(
  id: string,
  auth: AuthPort,
  port: RecordingPort,
  options: { recoverInterrupted?: boolean; force?: boolean; isActive?: () => boolean } = {}
): Promise<AudioDrainResult> {
  const idle: AudioDrainResult = { recordingId: id, pending: true, segments: [] };
  if (!navigator.locks || navigator.onLine === false) return { ...idle, retrying: true };
  const run = () =>
    navigator.locks.request(audioUploadLock(id), { ifAvailable: true }, async lock => {
      if (!lock) return idle;
      let row = (await listAudioSessions()).find(item => item.recordingId === id);
      if (!row) return { recordingId: id, pending: false, segments: [] };
      const owned = () => {
        const view = auth.getSession();
        return (
          view.activeSub === row!.ownerSub &&
          (view.activeSessionKey ?? view.activeSub) === row!.ownerSessionKey
        );
      };
      const token = async () => {
        if (!owned()) throw new Error('Recording owner is not active');
        const value = await auth.getTokenForSession(row!.ownerSessionKey);
        if (!value || !owned()) throw new Error('Recording owner is not active');
        return value;
      };
      if (!owned()) return idle;
      if (options.recoverInterrupted && row.stoppedAt === undefined)
        row = await stopAudioSession(id);
      const result: AudioDrainResult = { recordingId: id, pending: true, segments: [] };
      // Bounded batches avoid a large offline backlog monopolizing the worker/Stop.
      const chunks = await listAudioChunks(id);
      const blocked = chunks.some(
        chunk =>
          !chunk.acknowledged &&
          chunk.status &&
          chunk.status >= 400 &&
          chunk.status < 500 &&
          ![401, 408, 429].includes(chunk.status) &&
          chunk.nextAttemptAt > Date.now()
      );
      if (blocked && !options.force) return { ...idle, retrying: true };
      const due = chunks
        .filter(
          chunk => !chunk.acknowledged && (options.force || chunk.nextAttemptAt <= Date.now())
        )
        .slice(0, 3);
      await Promise.all(
        due.map(async chunk => {
          try {
            const wav = await readAudioChunk(chunk);
            const authToken = await token();
            const segments = await port.uploadTranscriptionChunk(id, wav, {
              chunkIndex: chunk.chunkIndex,
              chunkStartMs: (chunk.startSample / AUDIO_SAMPLE_RATE) * 1000,
              authToken,
              activeOrgId: row!.ownerOrgId,
            });
            if (!owned()) return;
            await updateAudioChunk({ ...chunk, acknowledged: true, error: undefined });
            result.segments.push(...segments);
          } catch (error) {
            result.error = error;
            await updateAudioChunk({
              ...chunk,
              attempts: chunk.attempts + 1,
              nextAttemptAt: Date.now() + retryDelay(error, chunk.attempts + 1),
              // Retain a safe classification only; never persist provider text or credentials.
              error: error instanceof ApiError ? error.code : 'UPLOAD_FAILED',
              status: error instanceof ApiError ? error.status : undefined,
            });
          }
        })
      );
      const pendingChunks = (await listAudioChunks(id)).filter(chunk => !chunk.acknowledged);
      const remaining = pendingChunks.length > 0;
      result.retrying = pendingChunks.some(chunk => chunk.attempts > 0);
      // The capture holder alone may seal the session. A live upload cannot finalize it.
      row = (await listAudioSessions()).find(item => item.recordingId === id);
      if (!row || remaining || row.stoppedAt === undefined || !owned()) return result;
      try {
        await finalizeRecording(id, (row.capturedSamples / AUDIO_SAMPLE_RATE) * 1000, {
          endedAt: row.stoppedAt,
          activeOrgId: row.ownerOrgId,
          authToken: await token(),
        });
        if (!owned() || options.isActive?.() === false) return result;
        await removeAudioSession(id);
        return { ...result, pending: false, completed: row };
      } catch (error) {
        return { ...result, retrying: true, error };
      }
    });
  // Recovery must not seal a live recording in another tab. The upload lock separately
  // serializes all senders, including overlapping focus/online/timer notifications.
  if (options.recoverInterrupted) {
    return navigator.locks.request(audioCaptureLock(id), { ifAvailable: true }, lock =>
      lock ? run() : idle
    );
  }
  return run();
}
