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
 *    call is idempotent, so the finalizer never reopens a closed writer.
 * A true `kill -9` skips the finalizer; the header keeps placeholder sizes, and
 * the drain recovers the sample count from the on-disk file size instead.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { Data, Effect, Either, type Scope } from 'effect';
import type { MeetingCaptureMode } from '@/types/meeting';
import { StreamingWavWriter } from '../../infra/audio/streaming-wav-writer';
import type { ScopedLog } from '../../infra/logging/service';
import { CAPTURE_SAMPLE_RATE, type ChunkSource } from './chunker';

export class RecoveryWriteError extends Data.TaggedError('RecoveryWriteError')<{
  readonly op: 'open' | 'append' | 'finalize';
  readonly source?: ChunkSource;
  readonly cause: unknown;
}> {}

export interface RecoveryWavSet {
  /** Directory holding the per-source WAV(s) — the outbox row's `wavPath`. */
  readonly dir: string;
  /** Append a source's samples before the pipeline accepts the frame. */
  readonly append: (source: ChunkSource, samples: Float32Array) => Effect.Effect<void, RecoveryWriteError>;
  /** Fix headers + close every open writer. Idempotent; safe to call before delete. */
  readonly finalizeAndClose: Effect.Effect<void, RecoveryWriteError>;
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
}): Effect.Effect<RecoveryWavSet, RecoveryWriteError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const sampleRate = params.sampleRate ?? CAPTURE_SAMPLE_RATE;
      yield* Effect.try({
        try: () => fs.mkdirSync(params.dir, { recursive: true }),
        catch: cause => new RecoveryWriteError({ op: 'open', cause }),
      });

      // Single-fiber access (the frame fiber appends; finalize runs only after it
      // is interrupted), so a plain map needs no lock.
      const writers = new Map<ChunkSource, StreamingWavWriter>();
      let closed = false;
      let closeFailure: RecoveryWriteError | undefined;

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

      const finalizeAndClose = Effect.gen(function* () {
        if (!closed) {
          closed = true;
          for (const [source, writer] of writers) {
            const result = yield* Effect.either(Effect.tryPromise({
              try: () => writer.finalize(),
              catch: cause => new RecoveryWriteError({ op: 'finalize', source, cause }),
            }));
            // Close every source, including when its sibling failed to close.
            if (Either.isLeft(result)) closeFailure ??= result.left;
          }
        }
        if (closeFailure) yield* Effect.fail(closeFailure);
      }).pipe(Effect.uninterruptible);

      const append = (source: ChunkSource, samples: Float32Array) => Effect.suspend(() => {
        if (closed || samples.length === 0) return Effect.void;
        return Effect.tryPromise({
          try: () => writerFor(source).appendAudio(samples),
          catch: cause => new RecoveryWriteError({ op: 'append', source, cause }),
        });
      });

      const set: RecoveryWavSet = { dir: params.dir, append, finalizeAndClose };
      return set;
    }),
    // On ANY scope close, fix headers + close so an interrupt retains valid WAVs.
    set => set.finalizeAndClose.pipe(Effect.catchAll(error =>
      params.log.warn('recovery WAV finalize failed', {
        source: error.source,
        reason: error.cause instanceof Error ? error.cause.message : String(error.cause),
      })
    ))
  );
