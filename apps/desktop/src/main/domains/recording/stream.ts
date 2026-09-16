import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Clock, Effect, Option, Queue, Result } from 'effect';
import { OrganizationsResponseSchema } from '@prismical/api-contracts/apps/v1';
import { OperationalDb } from '../../infra/operational-db/service';
import type {
  RecoveryStreamConfig,
  RecordingStreamSamples,
} from '../../infra/operational-db/schema';
import {
  WorkspaceBackend,
  type RecordingSegment,
  type WorkspaceBackendApi,
} from '../transport/service';
import { RecordingStreamError, type RecordingSocketEvent } from '../transport/recording-socket';
import { CAPTURE_SAMPLE_RATE, type ChunkSource } from './chunker';
import { wavFileName } from './recovery-writer';
import { decodeStreamMessage, type RecordingStreamMessage } from './stream-protocol';

/** Read the flag once, before persisting a new recording's transport choice. */
export const useRecordingStream = (backend: WorkspaceBackendApi) =>
  Effect.gen(function* () {
    const orgId = backend.identity?.activeOrgId;
    if (!backend.openRecordingSocket || !orgId) return false;
    const response = yield* backend
      .request({ method: 'GET', path: '/apps/v1/me/organizations' })
      .pipe(Effect.timeoutOption(5_000));
    if (Option.isNone(response) || !('ok' in response.value) || response.value.status !== 200)
      return false;
    const parsed = OrganizationsResponseSchema.safeParse(response.value.bodyJson);
    return (
      parsed.success &&
      parsed.data.results.some(
        org => org.orgId === orgId && org.features?.recordingWebSocket === true
      )
    );
  });

/** Only publish sample counts after the recovery writer has finished its append. */
export interface RecordingStreamControl {
  readonly samples: Record<ChunkSource, number>;
  stopping: boolean;
  flush: number;
}

export const makeRecordingStreamControl = (): RecordingStreamControl => ({
  samples: { mic: 0, system: 0 },
  stopping: false,
  flush: 0,
});

export interface RecordingStreamInput {
  readonly recordingId: string;
  readonly wavDir: string;
  readonly captureMode: 'mic' | 'system' | 'dual';
  readonly config: RecoveryStreamConfig;
  readonly control: RecordingStreamControl;
  readonly onTranscript: (segments: readonly RecordingSegment[]) => Effect.Effect<void>;
  readonly onLimit: Effect.Effect<void>;
  /** Recovery verifies an open server session against the durable stop metadata. */
  readonly expectedSamples?: RecordingStreamSamples;
}

export interface RecordingStreamResult {
  readonly durationMs: number;
  readonly status: 'done' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly segments: readonly RecordingSegment[];
}

/** Replay directly from retained PCM16 WAVs; network outages do not grow an audio queue. */
export const runRecordingStream = (input: RecordingStreamInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = yield* WorkspaceBackend;
      const db = yield* OperationalDb;
      const connect = backend.openRecordingSocket;
      if (!connect)
        return yield* Effect.fail(
          new RecordingStreamError({ code: 'unavailable', retryable: true })
        );
      const lanes: ChunkSource[] =
        input.captureMode === 'dual' ? ['mic', 'system'] : [input.captureMode];
      const files = new Map<ChunkSource, FileHandle>();
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all([...files.values()].map(file => file.close()));
        })
      );
      const frame = (lane: ChunkSource, start: number, count: number) =>
        Effect.tryPromise({
          try: async () => {
            let file = files.get(lane);
            if (!file) {
              file = await open(path.join(input.wavDir, wavFileName[lane]), 'r');
              files.set(lane, file);
            }
            const packet = Buffer.alloc(5 + count * 2);
            packet[0] = lane === 'mic' ? 0 : 1;
            packet.writeUInt32LE(start, 1);
            const { bytesRead } = await file.read(packet, 5, count * 2, 44 + start * 2);
            if (bytesRead !== count * 2) throw new Error('incomplete audio');
            return packet;
          },
          catch: () => new RecordingStreamError({ code: 'recovery-audio', retryable: false }),
        }).pipe(Effect.uninterruptible);
      let attempt = input.config.connectionAttempt;
      let retryStarted: number | undefined;
      let checkpoints = { mic: 0, system: 0 };
      const runConnection = Effect.scoped(
        Effect.gen(function* () {
          // Reserve BEFORE connecting: even a lost handshake consumes its attempt number.
          attempt += 1;
          yield* db
            .updateRecoveryOutbox(input.recordingId, {
              streamConfig: { captureId: input.config.captureId, connectionAttempt: attempt },
            })
            .pipe(
              Effect.mapError(
                () => new RecordingStreamError({ code: 'recovery-state', retryable: true })
              )
            );
          const socket = yield* connect(input.recordingId);
          const connectedAt = yield* Clock.currentTimeMillis;
          let lastProgress = connectedAt;
          let phase: 'connecting' | 'sending' | 'stopping' | 'finalizing' = 'connecting';
          let observing = false;
          let stoppedDuration: number | undefined;
          let sent = { mic: 0, system: 0 };
          let maxFrameSamples = CAPTURE_SAMPLE_RATE / 2;
          let limitSamples = 0xffff_ffff;
          let progressTimeoutMs = 30_000;
          let nextLane = 0;
          let flushed = 0;
          let flushSent = false;
          const outstandingFrames: { lane: ChunkSource; end: number }[] = [];
          const acknowledge = (next: typeof checkpoints) =>
            Effect.gen(function* () {
              for (const lane of ['mic', 'system'] as const) {
                if (
                  next[lane] < checkpoints[lane] ||
                  (!observing && next[lane] > sent[lane]) ||
                  (!lanes.includes(lane) && next[lane] !== 0)
                )
                  return yield* Effect.fail(
                    new RecordingStreamError({ code: 'checkpoint', retryable: false })
                  );
              }
              checkpoints = next;
              for (let i = outstandingFrames.length - 1; i >= 0; i--)
                if (outstandingFrames[i]!.end <= next[outstandingFrames[i]!.lane])
                  outstandingFrames.splice(i, 1);
            });
          while (true) {
            const event: Option.Option<RecordingSocketEvent> = yield* Queue.take(
              socket.events
            ).pipe(Effect.timeoutOption(['stopping', 'finalizing'].includes(phase) ? 240_000 : 20));
            const now = yield* Clock.currentTimeMillis;
            if (Option.isSome(event)) {
              const value: RecordingSocketEvent = event.value;
              if (value.type === 'close')
                return yield* Effect.fail(
                  new RecordingStreamError({
                    code: value.code === 4009 ? 'superseded' : 'connection-closed',
                    retryable: value.code !== 4009,
                  })
                );
              if (value.type === 'open') {
                yield* socket.send(
                  JSON.stringify({
                    type: 'start',
                    version: 1,
                    captureId: input.config.captureId,
                    connectionAttempt: attempt,
                    sampleRate: CAPTURE_SAMPLE_RATE,
                    lanes,
                  })
                );
              } else {
                const message: RecordingStreamMessage = yield* decodeStreamMessage(value.data);
                if (message.type === 'error')
                  return yield* Effect.fail(new RecordingStreamError(message));
                if (message.type === 'ready') {
                  if (
                    phase !== 'connecting' ||
                    message.lanes.length !== lanes.length ||
                    lanes.some(lane => !message.lanes.includes(lane))
                  )
                    return yield* Effect.fail(
                      new RecordingStreamError({ code: 'format', retryable: false })
                    );
                  observing = message.status !== 'open';
                  phase = observing ? 'stopping' : 'sending';
                  if (
                    !observing &&
                    input.expectedSamples &&
                    lanes.some(lane => input.control.samples[lane] !== input.expectedSamples![lane])
                  )
                    return yield* Effect.fail(
                      new RecordingStreamError({
                        code: 'recovery-audio-incomplete',
                        retryable: false,
                      })
                    );
                  // A resumed checkpoint may include frames sent by an earlier connection.
                  sent = { ...input.control.samples };
                  yield* acknowledge(message.checkpoints);
                  sent = { ...checkpoints };
                  maxFrameSamples = Math.min(
                    maxFrameSamples,
                    Math.floor((message.maxFrameBytes - 5) / 2)
                  );
                  limitSamples = Math.floor(
                    (message.recordingLimitMs * CAPTURE_SAMPLE_RATE) / 1000
                  );
                  progressTimeoutMs = Math.max(30_000, message.gcsFlushIntervalMs + 10_000);
                  if (observing || lanes.some(lane => input.control.samples[lane] >= limitSamples))
                    yield* input.onLimit;
                } else if (phase === 'connecting') {
                  return yield* Effect.fail(
                    new RecordingStreamError({ code: 'not-ready', retryable: false })
                  );
                } else if (message.type === 'ack') {
                  yield* acknowledge(message.checkpoints);
                } else if (message.type === 'transcript' || message.type === 'finalized') {
                  if (message.results.some(segment => segment.recordingId !== input.recordingId))
                    return yield* Effect.fail(
                      new RecordingStreamError({ code: 'recording-mismatch', retryable: false })
                    );
                  if (message.type === 'finalized') {
                    if (stoppedDuration === undefined)
                      return yield* Effect.fail(
                        new RecordingStreamError({ code: 'not-stopped', retryable: false })
                      );
                    // Capture can still be closing after a server-initiated stop. Wait for
                    // its final durable sample counts before allowing audio cleanup.
                    while (!input.control.stopping) yield* Effect.sleep(20);
                    const expected = input.expectedSamples ?? input.control.samples;
                    const unsaved = lanes.some(lane => checkpoints[lane] < expected[lane]);
                    return {
                      durationMs: stoppedDuration,
                      status: unsaved ? 'failed' : message.status,
                      reason: unsaved ? 'unsaved-audio' : message.reason,
                      segments: message.results,
                    } satisfies RecordingStreamResult;
                  }
                  yield* input.onTranscript(message.results);
                } else if (message.type === 'stopped') {
                  yield* acknowledge(message.checkpoints);
                  stoppedDuration = message.durationMs;
                  phase = 'finalizing';
                  yield* input.onLimit;
                }
                lastProgress = now;
              }
            }
            if (phase === 'connecting' && now - connectedAt >= 10_000)
              return yield* Effect.fail(
                new RecordingStreamError({ code: 'connect-timeout', retryable: true })
              );
            const outstanding = lanes.some(lane => sent[lane] > checkpoints[lane]);
            if (
              phase !== 'connecting' &&
              now - connectedAt >= 30_000 &&
              ((!outstanding && phase === 'sending') || now - lastProgress < 30_000)
            )
              retryStarted = undefined;
            if (
              phase !== 'connecting' &&
              (outstanding || phase !== 'sending') &&
              now - lastProgress >= (phase === 'sending' ? progressTimeoutMs : 240_000)
            )
              return yield* Effect.fail(
                new RecordingStreamError({ code: 'progress-timeout', retryable: true })
              );
            if (phase !== 'sending') continue;
            if (lanes.some(lane => input.control.samples[lane] >= limitSamples))
              yield* input.onLimit;
            // Round-robin lanes with a bounded outstanding window and native socket buffer.
            while (outstandingFrames.length < 32) {
              let sending = false;
              for (let i = 0; i < lanes.length; i++) {
                const lane = lanes[nextLane]!;
                nextLane = (nextLane + 1) % lanes.length;
                const target = Math.min(input.control.samples[lane], limitSamples);
                const count = Math.min(maxFrameSamples, target - sent[lane]);
                if (
                  count <= 0 ||
                  (count < maxFrameSamples &&
                    !input.control.stopping &&
                    input.control.flush === flushed)
                )
                  continue;
                if (socket.bufferedAmount() + 5 + count * 2 > 128 * 1024) {
                  // Keep this lane's turn when only one frame fits after the next drain.
                  nextLane = (nextLane + lanes.length - 1) % lanes.length;
                  break;
                }
                yield* socket.send(yield* frame(lane, sent[lane], count));
                if (!lanes.some(source => sent[source] > checkpoints[source])) lastProgress = now;
                sent[lane] += count;
                outstandingFrames.push({ lane, end: sent[lane] });
                sending = true;
                flushSent = false;
                break;
              }
              if (!sending) break;
            }
            const sentAll = lanes.every(
              lane => sent[lane] >= Math.min(input.control.samples[lane], limitSamples)
            );
            if (input.control.stopping && sentAll) {
              // Stop includes a flush on the server.
              yield* socket.send(JSON.stringify({ type: 'stop' }));
              phase = 'stopping';
              lastProgress = now;
            } else if (
              !flushSent &&
              (outstandingFrames.length >= 32 || (sentAll && input.control.flush !== flushed))
            ) {
              yield* socket.send(JSON.stringify({ type: 'flush' }));
              flushSent = true;
              if (sentAll) flushed = input.control.flush;
            }
          }
        })
      );
      while (true) {
        const result = yield* Effect.result(runConnection);
        if (Result.isSuccess(result)) return result.success;
        const now = yield* Clock.currentTimeMillis;
        retryStarted ??= now;
        if (!result.failure.retryable || now - retryStarted >= 90_000)
          return yield* Effect.fail(result.failure);
        yield* Effect.sleep(3_000);
      }
    })
  );
