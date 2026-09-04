import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Deferred, Duration, Effect, Layer, Option, Queue } from "effect";
import type { AudioFrame, MeetingCaptureMode } from "@/types/meeting";
import { assertAudioCaptureBinaryExists } from "../../../infra/audio-capture/audio-capture-binary";
import {
  createPacketReader,
  parseAecMode,
  parseMicEvent,
} from "../../../infra/audio-capture/packet-protocol";
import { AppConfig } from "../../../infra/config/service";
import { MainLogger } from "../../../infra/logging/service";
import {
  Capture,
  CaptureCrashError,
  CaptureExitError,
  CaptureProtocolError,
  CaptureSpawnError,
  type CaptureApi,
  type MicCaptureEvent,
  type CaptureOptions,
  type CaptureRuntimeError,
  type CaptureSession,
} from "./service";

/**
 * Bounded frame buffer (drop-oldest). ~1.7 s of headroom at the dual-mode worst
 * case (3 sources × ~100 frames/s of 10 ms frames). A well-behaved consumer
 * (the WAV writer) drains far faster than this fills; the cap is the OOM valve
 * for a stalled consumer, and every shed frame is metered.
 */
const FRAME_QUEUE_CAPACITY = 512;

/** SIGTERM → this grace → SIGKILL, mirroring the transplanted helper's stop(). */
const TERMINATION_GRACE = Duration.millis(1500);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The helper's CLI contract — preserve verbatim (fragile). */
const buildArgs = (
  mode: MeetingCaptureMode,
  platform: NodeJS.Platform,
  options?: CaptureOptions,
): string[] => {
  const args = ["--mode", mode];
  if (options?.debugArtifactsDir) {
    args.push("--debug-artifacts-dir", options.debugArtifactsDir);
  }
  if (options?.aecRenderHoldbackMs != null) {
    args.push("--aec-render-holdback-ms", String(options.aecRenderHoldbackMs));
  }
  if (options?.aecRenderWaitTimeoutMs != null) {
    args.push(
      "--aec-render-wait-timeout-ms",
      String(options.aecRenderWaitTimeoutMs),
    );
  }
  if (
    (platform === "darwin" || platform === "win32") &&
    mode !== "system" &&
    options?.micDeviceUid
  ) {
    args.push("--mic-device", options.micDeviceUid);
  }
  return args;
};

type CaptureChild = ChildProcessByStdio<Writable, Readable, Readable>;

export const CaptureLive: Layer.Layer<Capture, never, MainLogger | AppConfig> = Layer.effect(
  Capture,
  Effect.gen(function* () {
    const logger = yield* MainLogger;
    const config = yield* AppConfig;
    const log = logger.scoped("capture");
    const unsafeLog = logger.scopedUnsafe("capture");

    const capture: CaptureApi["capture"] = (mode, options) =>
      Effect.gen(function* () {
        const binaryPath = yield* Effect.try({
          try: () => assertAudioCaptureBinaryExists(),
          catch: (cause) =>
            new CaptureSpawnError({ mode, reason: errorMessage(cause) }),
        });

        const frames = yield* Queue.sliding<AudioFrame>(FRAME_QUEUE_CAPACITY);
        const micEvents = yield* Queue.sliding<MicCaptureEvent>(64);
        // The frame consumer races this: void on a clean stop, failed on a dead
        // helper (crash / unexpected exit / malformed packet).
        const terminated = yield* Deferred.make<void, CaptureRuntimeError>();
        // Resolved by the child's `exit` edge — the finalizer awaits it to
        // guarantee the process is reaped (no orphan) before the scope closes.
        const exited = yield* Deferred.make<void>();

        // Callback-edge state (single-threaded event loop; read via Effect.sync).
        const reader = createPacketReader();
        let aecMode = Option.none<string>();
        let dropped = 0;
        let stderrPending = "";
        let stopping = false;
        let dead = false;

        const onStdout = (chunk: Buffer): void => {
          if (dead) return;
          let decoded: AudioFrame[];
          try {
            decoded = reader.push(chunk);
          } catch (cause) {
            dead = true;
            const reason = errorMessage(cause);
            unsafeLog.warn("malformed capture packet — tearing down", {
              mode,
              reason,
            });
            Deferred.unsafeDone(
              terminated,
              Effect.fail(new CaptureProtocolError({ reason })),
            );
            return;
          }
          for (const frame of decoded) {
            // Sliding queue silently evicts; count the eviction ourselves.
            const size = Option.getOrElse(frames.unsafeSize(), () => 0);
            if (size >= FRAME_QUEUE_CAPACITY) {
              dropped += 1;
            }
            Queue.unsafeOffer(frames, frame);
          }
        };

        const onStderr = (chunk: Buffer): void => {
          stderrPending += chunk.toString("utf8");
          const lines = stderrPending.split(/\r?\n/);
          stderrPending = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const observed = parseAecMode(trimmed);
            if (observed) {
              aecMode = Option.some(observed);
            }
            const micEvent = parseMicEvent(trimmed);
            if (micEvent) {
              Queue.unsafeOffer(micEvents, micEvent);
            } else if (trimmed.startsWith("mic-event=")) {
              unsafeLog.warn("ignoring invalid mic event", { line: trimmed });
            }
          }
        };

        const onStdinError = (error: Error): void => {
          unsafeLog.warn("capture child stdin error", { reason: error.message });
        };

        const onError = (error: Error): void => {
          if (dead) return;
          dead = true;
          unsafeLog.warn("capture child errored", {
            mode,
            reason: error.message,
          });
          Deferred.unsafeDone(
            terminated,
            Effect.fail(new CaptureCrashError({ reason: error.message })),
          );
        };

        const onExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          Deferred.unsafeDone(exited, Effect.void);
          if (dead || stopping) {
            Deferred.unsafeDone(terminated, Effect.void);
            return;
          }
          dead = true;
          unsafeLog.warn("capture child exited unexpectedly", {
            mode,
            code,
            signal,
          });
          Deferred.unsafeDone(
            terminated,
            Effect.fail(new CaptureExitError({ code, signal })),
          );
        };

        const release = (proc: CaptureChild): Effect.Effect<void> =>
          Effect.gen(function* () {
            // Detach the data edges first so nothing enqueues mid-teardown; keep
            // `exit` until the child is reaped.
            yield* Effect.sync(() => {
              proc.stdout.removeListener("data", onStdout);
              proc.stderr.removeListener("data", onStderr);
              proc.removeListener("error", onError);
            });
            stopping = true;

            const alreadyExited = yield* Deferred.isDone(exited);
            if (!alreadyExited) {
              yield* Effect.sync(() => {
                if (config.platform === "win32") {
                  proc.stdin.end("stop\n");
                } else {
                  proc.kill("SIGTERM");
                }
              });
              // Wait up to the grace for a clean exit, then escalate to SIGKILL.
              // Finalizers run uninterruptibly, so mark the bounded wait
              // interruptible — otherwise the timeout could not interrupt the
              // pending await and teardown would hang.
              const graceful = yield* Deferred.await(exited).pipe(
                Effect.timeoutOption(TERMINATION_GRACE),
                Effect.interruptible,
              );
              if (Option.isNone(graceful)) {
                yield* Effect.sync(() => {
                  proc.kill("SIGKILL");
                });
                // A SIGKILL'd process is normally reaped in milliseconds, but one
                // wedged in an uninterruptible kernel wait (D-state — e.g. a stuck
                // CoreAudio driver call) never returns from its syscall, so `exit`
                // never fires. Bound this wait too (interruptible, like the grace
                // above) so a wedged child can't hang teardown/quit forever — we
                // give up and detach regardless once the grace elapses.
                yield* Deferred.await(exited).pipe(
                  Effect.timeoutOption(TERMINATION_GRACE),
                  Effect.interruptible,
                );
              }
            }

            yield* Effect.sync(() => {
              proc.stdin.removeListener("error", onStdinError);
              proc.removeListener("exit", onExit);
            });
            yield* Queue.shutdown(frames);
            yield* Queue.shutdown(micEvents);
            yield* log.info("capture child reaped", { mode });
          });

        const proc = yield* Effect.acquireRelease(
          Effect.try({
            try: (): CaptureChild => {
              const proc = spawn(binaryPath, buildArgs(mode, config.platform, options), {
                stdio: ["pipe", "pipe", "pipe"],
              }) as CaptureChild;
              proc.stdin.on("error", onStdinError);
              proc.stdout.on("data", onStdout);
              proc.stderr.on("data", onStderr);
              proc.on("error", onError);
              proc.on("exit", onExit);
              return proc;
            },
            catch: (cause) =>
              new CaptureSpawnError({ mode, reason: errorMessage(cause) }),
          }),
          (proc) => release(proc),
        );

        yield* log.info("capture child spawned", { mode });

        const session: CaptureSession = {
          mode,
          frames,
          aec: Effect.sync(() => aecMode),
          micEvents,
          sendMicCommand: command =>
            Effect.sync(() => {
              if (
                (config.platform !== "darwin" && config.platform !== "win32") ||
                mode === "system" ||
                stopping ||
                dead
              ) return;
              proc.stdin.write(`${JSON.stringify(command)}\n`);
            }),
          droppedFrames: Effect.sync(() => dropped),
          awaitExit: Deferred.await(terminated),
        };
        return session;
      });

    return { capture };
  }),
);
