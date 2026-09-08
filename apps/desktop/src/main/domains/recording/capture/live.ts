import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { Deferred, Duration, Effect, Layer, Option, Queue } from 'effect';
import { makeProcessDiagnostics } from '../../../infra/logging/process-diagnostics';
import type { AudioFrame, MeetingCaptureMode } from '@/types/meeting';
import { assertAudioCaptureBinaryExists } from '../../../infra/audio-capture/audio-capture-binary';
import {
  createPacketReader,
  parseAecMode,
  parseMicEvent,
} from '../../../infra/audio-capture/packet-protocol';
import { TelemetryService } from '../../telemetry/service';
import { makeProcessFailureReporter } from '../../telemetry/process-failure-reporter';
import { AppConfig } from '../../../infra/config/service';
import { MainLogger, LoggingTransport } from '../../../infra/logging/service';
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
} from './service';

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
  options?: CaptureOptions
): string[] => {
  const args = ['--mode', mode];
  if (options?.debugArtifactsDir) {
    args.push('--debug-artifacts-dir', options.debugArtifactsDir);
  }
  if (options?.aecRenderHoldbackMs != null) {
    args.push('--aec-render-holdback-ms', String(options.aecRenderHoldbackMs));
  }
  if (options?.aecRenderWaitTimeoutMs != null) {
    args.push('--aec-render-wait-timeout-ms', String(options.aecRenderWaitTimeoutMs));
  }
  if (
    (platform === 'darwin' || platform === 'win32') &&
    mode !== 'system' &&
    options?.micDeviceUid
  ) {
    args.push('--mic-device', options.micDeviceUid);
  }
  return args;
};

type CaptureChild = ChildProcessByStdio<Writable, Readable, Readable>;

export const CaptureLive: Layer.Layer<
  Capture,
  never,
  MainLogger | LoggingTransport | AppConfig | TelemetryService
> = Layer.effect(
  Capture,
  Effect.gen(function* () {
    const logger = yield* MainLogger;
    const config = yield* AppConfig;
    const transport = yield* LoggingTransport;
    const telemetry = yield* TelemetryService;
    const log = logger.scoped('capture');
    const unsafeLog = logger.scopedSync('capture');

    const capture: CaptureApi['capture'] = (mode, options) =>
      Effect.gen(function* () {
        const reportFailure = yield* makeProcessFailureReporter(telemetry, unsafeLog);
        const binaryPath = yield* Effect.try({
          try: () => assertAudioCaptureBinaryExists(),
          catch: cause => new CaptureSpawnError({ mode, reason: errorMessage(cause) }),
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
        let childPid = process.pid;
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
            const error = new CaptureProtocolError({ reason });
            reportFailure(error);
            unsafeLog.error('malformed capture packet — tearing down', {
              context: { mode },
              error,
            });
            Deferred.unsafeDone(terminated, Effect.fail(error));
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

        const diagnostics = makeProcessDiagnostics(
          transport,
          () => ({ runtime: 'native', pid: childPid }),
          'audio-capture',
          line => {
            const observed = parseAecMode(line);
            if (observed) {
              aecMode = Option.some(observed);
              return !line.startsWith('{');
            }
            const micEvent = parseMicEvent(line);
            if (micEvent) {
              Queue.unsafeOffer(micEvents, micEvent);
              return true;
            }
            if (line.startsWith('mic-event=')) {
              unsafeLog.warn('Ignoring invalid microphone control event');
              return true;
            }
            return false;
          }
        );
        const onStderr = diagnostics.push;

        const onStdinError = (error: Error): void => {
          unsafeLog.warn('capture child stdin error', { error });
        };

        const onError = (error: Error): void => {
          if (dead || stopping) return;
          dead = true;
          reportFailure(error);
          unsafeLog.error('capture child errored', { context: { mode }, error });
          Deferred.unsafeDone(
            terminated,
            Effect.fail(new CaptureCrashError({ reason: error.message }))
          );
        };

        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          diagnostics.end();
          Deferred.unsafeDone(exited, Effect.void);
          if (dead || stopping) {
            Deferred.unsafeDone(terminated, Effect.void);
            return;
          }
          dead = true;
          reportFailure(new CaptureExitError({ code, signal }), { exit_code: code });
          unsafeLog.error('capture child exited unexpectedly', {
            context: { mode, code, signal },
          });
          Deferred.unsafeDone(terminated, Effect.fail(new CaptureExitError({ code, signal })));
        };

        const release = (proc: CaptureChild): Effect.Effect<void> =>
          Effect.gen(function* () {
            // Detach the data edges first so nothing enqueues mid-teardown; keep
            // `exit` until the child is reaped.
            yield* Effect.sync(() => {
              proc.stdout.removeListener('data', onStdout);
              proc.stderr.removeListener('data', onStderr);
              proc.removeListener('error', onError);
            });
            stopping = true;

            const alreadyExited = yield* Deferred.isDone(exited);
            if (!alreadyExited) {
              yield* Effect.sync(() => {
                if (config.platform === 'win32') {
                  proc.stdin.end('stop\n');
                } else {
                  proc.kill('SIGTERM');
                }
              });
              // Wait up to the grace for a clean exit, then escalate to SIGKILL.
              // Finalizers run uninterruptibly, so mark the bounded wait
              // interruptible — otherwise the timeout could not interrupt the
              // pending await and teardown would hang.
              const graceful = yield* Deferred.await(exited).pipe(
                Effect.timeoutOption(TERMINATION_GRACE),
                Effect.interruptible
              );
              if (Option.isNone(graceful)) {
                yield* Effect.sync(() => {
                  proc.kill('SIGKILL');
                });
                // A SIGKILL'd process is normally reaped in milliseconds, but one
                // wedged in an uninterruptible kernel wait (D-state — e.g. a stuck
                // CoreAudio driver call) never returns from its syscall, so `exit`
                // never fires. Bound this wait too (interruptible, like the grace
                // above) so a wedged child can't hang teardown/quit forever — we
                // give up and detach regardless once the grace elapses.
                yield* Deferred.await(exited).pipe(
                  Effect.timeoutOption(TERMINATION_GRACE),
                  Effect.interruptible
                );
              }
            }

            yield* Effect.sync(() => {
              proc.stdin.removeListener('error', onStdinError);
              proc.removeListener('exit', onExit);
            });
            yield* Queue.shutdown(frames);
            yield* Queue.shutdown(micEvents);
            yield* log.info('capture child reaped', {
              context: { mode, droppedFrames: dropped },
            });
          });

        const proc = yield* Effect.acquireRelease(
          Effect.try({
            try: (): CaptureChild => {
              const proc = spawn(binaryPath, buildArgs(mode, config.platform, options), {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, DESKTOP_APP_RUN_ID: logger.appRunId },
              }) as CaptureChild;
              childPid = proc.pid ?? process.pid;
              proc.stdin.on('error', onStdinError);
              proc.stdout.on('data', onStdout);
              proc.stderr.on('data', onStderr);
              proc.on('error', onError);
              proc.on('exit', onExit);
              return proc;
            },
            catch: cause => new CaptureSpawnError({ mode, reason: errorMessage(cause) }),
          }),
          proc => release(proc)
        );

        yield* log.info('capture child spawned', { context: { mode } });

        const session: CaptureSession = {
          mode,
          frames,
          aec: Effect.sync(() => aecMode),
          micEvents,
          sendMicCommand: command =>
            Effect.sync(() => {
              if (
                (config.platform !== 'darwin' && config.platform !== 'win32') ||
                mode === 'system' ||
                stopping ||
                dead
              )
                return;
              proc.stdin.write(`${JSON.stringify(command)}\n`);
            }),
          droppedFrames: Effect.sync(() => dropped),
          awaitExit: Deferred.await(terminated),
        };
        return session;
      });

    return { capture };
  })
);
