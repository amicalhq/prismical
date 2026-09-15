import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  SubscriptionRef,
} from 'effect';
import type { MicActivitySnapshotEvent } from '@/types/meeting-start-notifications';
import { TelemetryService } from '../../domains/telemetry/service';
import { makeProcessFailureReporter } from '../../domains/telemetry/process-failure-reporter';
import { MainLogger, LoggingTransport } from '../logging/service';
import { makeLineDecoder } from '@desktop/logging';
import { makeProcessDiagnostics } from '../logging/process-diagnostics';
import { assertMicDetectorBinaryExists } from './mic-detector-binary';
import { SnapshotMessageSchema } from './native-mic-activity-client';
import { MicActivity, type LatestMicActivity, type MicActivityApi } from './service';

const TERMINATION_GRACE = Duration.millis(1500);

class DetectorSpawnError extends Data.TaggedError('DetectorSpawnError')<{
  readonly reason: string;
}> {}

class DetectorCrashError extends Data.TaggedError('DetectorCrashError')<{
  readonly reason: string;
}> {}

class DetectorExitError extends Data.TaggedError('DetectorExitError')<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {}

type DetectorError = DetectorSpawnError | DetectorCrashError | DetectorExitError;
type DetectorChild = ChildProcessByStdio<Writable, Readable, Readable>;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const MicActivityLive: Layer.Layer<
  MicActivity,
  never,
  MainLogger | LoggingTransport | TelemetryService
> = Layer.effect(
  MicActivity,
  Effect.gen(function* () {
    const logger = yield* MainLogger;
    const transport = yield* LoggingTransport;
    const reportFailure = yield* makeProcessFailureReporter(
      yield* TelemetryService,
      logger.scopedSync('mic-activity')
    );
    const log = logger.scoped('mic-activity');
    const unsafeLog = logger.scopedSync('mic-activity');
    const latest = yield* SubscriptionRef.make<Option.Option<LatestMicActivity>>(Option.none());
    const context = yield* Effect.context<never>();

    const clearLatest = (): void => {
      Effect.runSyncWith(context)(SubscriptionRef.set(latest, Option.none()));
    };

    const publishSnapshot = (snapshot: MicActivitySnapshotEvent): void => {
      Effect.runSyncWith(context)(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap(receivedAtMs =>
            SubscriptionRef.set(latest, Option.some({ snapshot, receivedAtMs }))
          )
        )
      );
    };

    const spawnAndConsume: Effect.Effect<void, DetectorError> = Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* Effect.try({
          try: () => assertMicDetectorBinaryExists(),
          catch: cause => new DetectorSpawnError({ reason: errorMessage(cause) }),
        });

        const exited = yield* Deferred.make<void>();
        const terminated = yield* Deferred.make<void, DetectorError>();

        const stdoutLines = makeLineDecoder();
        let childPid = process.pid;
        const diagnostics = makeProcessDiagnostics(
          transport,
          () => ({ runtime: 'native', pid: childPid }),
          'mic-detector'
        );
        let stopping = false;
        let dead = false;

        const onStdout = (chunk: Buffer): void => {
          if (dead) return;
          const { lines, dropped } = stdoutLines.push(chunk);
          if (dropped)
            unsafeLog.warn('Oversized microphone snapshots discarded', {
              context: { droppedLines: dropped },
            });
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let raw: unknown;
            try {
              raw = JSON.parse(trimmed);
            } catch {
              unsafeLog.warn('mic-detector: ignoring non-JSON line', {
                context: { byteLength: Buffer.byteLength(trimmed) },
              });
              continue;
            }
            const parsed = SnapshotMessageSchema.safeParse(raw);
            if (!parsed.success) {
              unsafeLog.warn('mic-detector: ignoring invalid snapshot line');
              continue;
            }
            publishSnapshot(parsed.data);
          }
        };

        const onStderr = diagnostics.push;

        const onStdinError = (error: Error): void => {
          unsafeLog.warn('mic-detector child stdin error', {
            error,
          });
        };

        const onError = (error: Error): void => {
          if (dead || stopping) return;
          dead = true;
          reportFailure(error);
          clearLatest();
          unsafeLog.error('mic-detector child errored', { error });
          Deferred.doneUnsafe(
            terminated,
            Effect.fail(new DetectorCrashError({ reason: error.message }))
          );
        };

        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          clearLatest();
          diagnostics.end();
          Deferred.doneUnsafe(exited, Effect.void);
          if (dead || stopping) {
            Deferred.doneUnsafe(terminated, Effect.void);
            return;
          }
          dead = true;
          reportFailure(new DetectorExitError({ code, signal }), { exit_code: code });
          unsafeLog.error('mic-detector child exited unexpectedly', {
            context: { code, signal },
          });
          Deferred.doneUnsafe(terminated, Effect.fail(new DetectorExitError({ code, signal })));
        };

        const release = (proc: DetectorChild): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              proc.stdout.removeListener('data', onStdout);
              proc.stderr.removeListener('data', onStderr);
              proc.stdin.removeListener('error', onStdinError);
              proc.removeListener('error', onError);
            });
            stopping = true;

            const alreadyExited = yield* Deferred.isDone(exited);
            if (!alreadyExited) {
              yield* Effect.sync(() => {
                if (process.platform === 'win32') proc.stdin.end('stop\n');
                else proc.kill('SIGTERM');
              });
              const graceful = yield* Deferred.await(exited).pipe(
                Effect.timeoutOption(TERMINATION_GRACE)
              );
              if (Option.isNone(graceful)) {
                yield* Effect.sync(() => proc.kill('SIGKILL'));
                yield* Deferred.await(exited).pipe(
                  Effect.timeoutOption(TERMINATION_GRACE)
                );
              }
            }

            clearLatest();
            yield* Effect.sync(() => proc.removeListener('exit', onExit));
            yield* log.info('mic-detector reaped');
          });

        yield* Effect.acquireRelease(
          Effect.try({
            try: (): DetectorChild => {
              const proc = spawn(binaryPath, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, DESKTOP_APP_RUN_ID: logger.appRunId },
              }) as DetectorChild;
              childPid = proc.pid ?? process.pid;
              proc.stdin.on('error', onStdinError);
              proc.stdout.on('data', onStdout);
              proc.stderr.on('data', onStderr);
              proc.on('error', onError);
              proc.on('exit', onExit);
              return proc;
            },
            catch: cause => new DetectorSpawnError({ reason: errorMessage(cause) }),
          }),
          release
        );

        yield* log.info('mic-detector spawned');
        yield* Deferred.await(terminated);
      })
    );

    const supervisor = Effect.gen(function* () {
      let resetAt: number | undefined;
      let delayMs = 1_000;
      while (true) {
        const result = yield* Effect.result(spawnAndConsume);
        if (Result.isSuccess(result)) return;
        yield* log.warn('mic-detector terminated — restart per policy', { error: result.failure });
        const now = yield* Clock.currentTimeMillis;
        // Preserve the existing elapsed-time reset, including waits and child runtime.
        if (resetAt === undefined || now - resetAt >= 60_000) {
          resetAt = now;
          delayMs = 1_000;
        }
        yield* Effect.sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    });

    yield* Effect.forkScoped(supervisor);

    const api: MicActivityApi = { latest };
    return api;
  })
);
