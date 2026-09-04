/**
 * The recovery-scoped WAV set.
 *
 * One on-disk WAV per source under a per-recording directory in the userData
 * recovery area — the crash/interrupt artifact the drain re-chunks and
 * re-uploads. Wraps the transplanted `StreamingWavWriter` (infra/audio): a valid
 * RIFF/fmt/data header, incremental Float32 → 16-bit PCM appends, header sizes
 * patched on `finalize()`.
 *
 * Lifecycle (the whole point):
 *  - a writer is created lazily on the FIRST frame of a source, so a mic-only
 *    recording never opens `system.wav`;
 *  - the scoped finalizer runs `finalizeAndClose` on ANY scope close (graceful
 *    stop OR sign-out/quit interrupt), so an interrupt leaves a VALID, parseable
 *    WAV behind (retained for the drain) — not a placeholder-header stub;
 *  - the graceful-stop path calls `finalizeAndClose` explicitly BEFORE deleting
 *    the directory, so files are closed when they are removed. The
 *    call is idempotent, so the finalizer re-running is a no-op.
 * A true `kill -9` skips the finalizer; the header keeps placeholder sizes, and
 * the drain recovers the sample count from the on-disk file size instead.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { Effect, type Scope } from 'effect';
import type { MeetingCaptureMode } from '@/types/meeting';
import { StreamingWavWriter } from '../../infra/audio/streaming-wav-writer';
import type { ScopedLog } from '../../infra/logging/service';
import { CAPTURE_SAMPLE_RATE, type ChunkSource } from './chunker';

export interface RecoveryWavSet {
  /** Directory holding the per-source WAV(s) — the outbox row's `wavPath`. */
  readonly dir: string;
  /** Append a source's samples; disk errors are logged and swallowed (best-effort artifact). */
  readonly append: (source: ChunkSource, samples: Float32Array) => Effect.Effect<void>;
  /** Fix headers + close every open writer. Idempotent; safe to call before delete. */
  readonly finalizeAndClose: Effect.Effect<void>;
}

/** Per-source WAV file names within the recovery directory — the drain reopens
 * these EXACT names to re-chunk, so they're shared, not re-declared. */
export const wavFileName: Record<ChunkSource, string> = { mic: 'mic.wav', system: 'system.wav' };

/**
 * Open a recovery WAV set scoped to the caller. `mkdir -p dir` on acquire; the
 * finalizer fixes headers + closes (retaining valid WAVs on interrupt).
 */
export const makeRecoveryWavSet = (params: {
  readonly dir: string;
  readonly mode: MeetingCaptureMode;
  readonly log: ScopedLog;
  readonly sampleRate?: number;
}): Effect.Effect<RecoveryWavSet, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const sampleRate = params.sampleRate ?? CAPTURE_SAMPLE_RATE;
      yield* Effect.sync(() => fs.mkdirSync(params.dir, { recursive: true }));

      // Single-fiber access (the frame fiber appends; finalize runs only after it
      // is interrupted), so a plain map needs no lock.
      const writers = new Map<ChunkSource, StreamingWavWriter>();
      let closed = false;

      const writerFor = (source: ChunkSource): StreamingWavWriter => {
        const existing = writers.get(source);
        if (existing) return existing;
        const created = new StreamingWavWriter(
          path.join(params.dir, wavFileName[source]),
          sampleRate,
          1,
          16
        );
        writers.set(source, created);
        return created;
      };

      const finalizeAndClose: Effect.Effect<void> = Effect.gen(function* () {
        if (closed) return;
        closed = true;
        for (const [source, writer] of writers) {
          yield* Effect.tryPromise(() => writer.finalize()).pipe(
            Effect.catchAll(cause =>
              params.log.warn('recovery WAV finalize failed', {
                source,
                reason: cause instanceof Error ? cause.message : String(cause),
              })
            )
          );
        }
      });

      const append = (source: ChunkSource, samples: Float32Array): Effect.Effect<void> => {
        if (closed || samples.length === 0) return Effect.void;
        return Effect.tryPromise(() => writerFor(source).appendAudio(samples)).pipe(
          Effect.catchAll(cause =>
            params.log.warn('recovery WAV append failed', {
              source,
              reason: cause instanceof Error ? cause.message : String(cause),
            })
          )
        );
      };

      const set: RecoveryWavSet = { dir: params.dir, append, finalizeAndClose };
      return set;
    }),
    // On ANY scope close, fix headers + close so an interrupt retains valid WAVs.
    set => set.finalizeAndClose
  );
