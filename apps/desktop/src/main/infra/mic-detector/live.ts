import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Runtime,
  Schedule,
  SubscriptionRef,
} from "effect";
import type { MicActivitySnapshotEvent } from "@/types/meeting-start-notifications";
import { MainLogger } from "../logging/service";
import { assertMicDetectorBinaryExists } from "./mic-detector-binary";
import { SnapshotMessageSchema } from "./native-mic-activity-client";
import {
  MicActivity,
  type LatestMicActivity,
  type MicActivityApi,
} from "./service";

const TERMINATION_GRACE = Duration.millis(1500);

const RESTART_SCHEDULE = Schedule.either(
  Schedule.exponential(Duration.seconds(1), 2),
  Schedule.spaced(Duration.seconds(30)),
).pipe(Schedule.resetAfter(Duration.seconds(60)));

class DetectorSpawnError extends Data.TaggedError("DetectorSpawnError")<{
  readonly reason: string;
}> {}

class DetectorCrashError extends Data.TaggedError("DetectorCrashError")<{
  readonly reason: string;
}> {}

class DetectorExitError extends Data.TaggedError("DetectorExitError")<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {}

type DetectorError =
  | DetectorSpawnError
  | DetectorCrashError
  | DetectorExitError;
type DetectorChild = ChildProcessByStdio<Writable, Readable, Readable>;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const MicActivityLive: Layer.Layer<MicActivity, never, MainLogger> =
  Layer.scoped(
    MicActivity,
    Effect.gen(function* () {
      const logger = yield* MainLogger;
      const log = logger.scoped("mic-activity");
      const unsafeLog = logger.scopedUnsafe("mic-activity");
      const latest = yield* SubscriptionRef.make<
        Option.Option<LatestMicActivity>
      >(Option.none());
      const runtime = yield* Effect.runtime<never>();

      const clearLatest = (): void => {
        Runtime.runSync(runtime)(SubscriptionRef.set(latest, Option.none()));
      };

      const publishSnapshot = (snapshot: MicActivitySnapshotEvent): void => {
        Runtime.runSync(runtime)(
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((receivedAtMs) =>
              SubscriptionRef.set(
                latest,
                Option.some({ snapshot, receivedAtMs }),
              ),
            ),
          ),
        );
      };

      const spawnAndConsume: Effect.Effect<void, DetectorError> = Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* Effect.try({
            try: () => assertMicDetectorBinaryExists(),
            catch: (cause) =>
              new DetectorSpawnError({ reason: errorMessage(cause) }),
          });

          const exited = yield* Deferred.make<void>();
          const terminated = yield* Deferred.make<void, DetectorError>();

          let stdoutPending = "";
          let stderrPending = "";
          let stopping = false;
          let dead = false;

          const onStdout = (chunk: Buffer): void => {
            if (dead) return;
            stdoutPending += chunk.toString("utf8");
            const lines = stdoutPending.split(/\r?\n/);
            stdoutPending = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let raw: unknown;
              try {
                raw = JSON.parse(trimmed);
              } catch {
                unsafeLog.warn("mic-detector: ignoring non-JSON line", {
                  line: trimmed,
                });
                continue;
              }
              const parsed = SnapshotMessageSchema.safeParse(raw);
              if (!parsed.success) {
                unsafeLog.warn("mic-detector: ignoring invalid snapshot line");
                continue;
              }
              publishSnapshot(parsed.data);
            }
          };

          const onStderr = (chunk: Buffer): void => {
            stderrPending += chunk.toString("utf8");
            const lines = stderrPending.split(/\r?\n/);
            stderrPending = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) unsafeLog.info("mic-detector", { line: trimmed });
            }
          };

          const onStdinError = (error: Error): void => {
            unsafeLog.warn("mic-detector child stdin error", {
              reason: error.message,
            });
          };

          const onError = (error: Error): void => {
            if (dead) return;
            dead = true;
            clearLatest();
            unsafeLog.warn("mic-detector child errored", {
              reason: error.message,
            });
            Deferred.unsafeDone(
              terminated,
              Effect.fail(new DetectorCrashError({ reason: error.message })),
            );
          };

          const onExit = (
            code: number | null,
            signal: NodeJS.Signals | null,
          ): void => {
            clearLatest();
            Deferred.unsafeDone(exited, Effect.void);
            if (dead || stopping) {
              Deferred.unsafeDone(terminated, Effect.void);
              return;
            }
            dead = true;
            unsafeLog.warn("mic-detector child exited unexpectedly", {
              code,
              signal,
            });
            Deferred.unsafeDone(
              terminated,
              Effect.fail(new DetectorExitError({ code, signal })),
            );
          };

          const release = (proc: DetectorChild): Effect.Effect<void> =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                proc.stdout.removeListener("data", onStdout);
                proc.stderr.removeListener("data", onStderr);
                proc.stdin.removeListener("error", onStdinError);
                proc.removeListener("error", onError);
              });
              stopping = true;

              const alreadyExited = yield* Deferred.isDone(exited);
              if (!alreadyExited) {
                yield* Effect.sync(() => {
                  if (process.platform === "win32") proc.stdin.end("stop\n");
                  else proc.kill("SIGTERM");
                });
                const graceful = yield* Deferred.await(exited).pipe(
                  Effect.timeoutOption(TERMINATION_GRACE),
                  Effect.interruptible,
                );
                if (Option.isNone(graceful)) {
                  yield* Effect.sync(() => proc.kill("SIGKILL"));
                  yield* Deferred.await(exited).pipe(
                    Effect.timeoutOption(TERMINATION_GRACE),
                    Effect.interruptible,
                  );
                }
              }

              clearLatest();
              yield* Effect.sync(() => proc.removeListener("exit", onExit));
              yield* log.info("mic-detector reaped");
            });

          yield* Effect.acquireRelease(
            Effect.try({
              try: (): DetectorChild => {
                const proc = spawn(binaryPath, [], {
                  stdio: ["pipe", "pipe", "pipe"],
                }) as DetectorChild;
                proc.stdin.on("error", onStdinError);
                proc.stdout.on("data", onStdout);
                proc.stderr.on("data", onStderr);
                proc.on("error", onError);
                proc.on("exit", onExit);
                return proc;
              },
              catch: (cause) =>
                new DetectorSpawnError({ reason: errorMessage(cause) }),
            }),
            release,
          );

          yield* log.info("mic-detector spawned", { binaryPath });
          yield* Deferred.await(terminated);
        }),
      );

      const supervisor = spawnAndConsume.pipe(
        Effect.tapError((error) =>
          log.warn("mic-detector terminated — restart per policy", {
            error: error._tag,
          }),
        ),
        Effect.retry(RESTART_SCHEDULE),
        Effect.catchAll(() => Effect.void),
      );

      yield* Effect.forkScoped(supervisor);

      const api: MicActivityApi = { latest };
      return api;
    }),
  );
