/**
 * WhisperEngineLive — the whisper.cpp worker host. See
 * service.ts for the contract; this file is the fork recipe + the IPC pump,
 * with paths verified by scripts/transcribe-fixture.ts:
 *
 *   execPath   packaged  <Resources>/node[.exe]   (the bundled Node SIDECAR — the
 *                        RunAsNode fuse is burned, electron can never be the worker)
 *              dev       apps/desktop/node-binaries/<platform>-<arch>/node (`pnpm download-node`)
 *   worker     packaged  <Resources>/app.asar.unpacked/.vite/build/whisper-worker-fork.js
 *                        (main's __dirname is inside app.asar — rewritten to .unpacked,
 *                        fork() needs a real file)
 *              dev       apps/desktop/.vite/build/whisper-worker-fork.js (forge start /
 *                        `pnpm build:worker`)
 *   env        ELECTRON_RUN_AS_NODE=1 (harmless for the sidecar), NODE_OPTIONS
 *              REPLACED (never inherited — a tsx/vitest loader in the parent must not
 *              leak into the worker), execArgv: [] for the same reason, silent: true
 *              with stdout/stderr drained into the log (ggml prints model info to
 *              stderr; an undrained pipe would eventually block the worker).
 *
 * Lifecycle: forked lazily on the first call, re-forked transparently after a
 * crash (the requested model is re-loaded on the next transcribe), killed on
 * timeout (a synchronous decode cannot be cancelled — the stuck worker is
 * replaced) and when the boot scope closes. Pending calls are settled typed on
 * every exit edge: `error` (a bad execPath is ENOENT + `close`, no `exit`) and
 * `exit` (a worker that dies loading whisper.node exits 1 before any message).
 *
 * Under tests/static-gate.test.ts's infra/whisper exclusion, but Effect-clean
 * anyway: the only timer is Effect.timeoutFail.
 */
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import path from 'node:path';
import { Duration, Effect, Layer } from 'effect';
import { TelemetryService } from '../../domains/telemetry/service';
import { makeProcessFailureReporter } from '../../domains/telemetry/process-failure-reporter';
import { AppConfig } from '../config/service';
import { MainLogger, LoggingTransport } from '../logging/service';
import { makeProcessDiagnostics } from '../logging/process-diagnostics';
import { parseWire } from '@desktop/logging';
import {
  isWorkerLogFrame,
  serializeArg,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerTranscription,
} from './protocol';
import { WhisperEngine, WhisperEngineError, type WhisperEngineApi } from './service';

/**
 * Budget for ONE decode of a ≤15 s chunk. Deliberately generous: whisper.cpp
 * pads every chunk to a full 30 s encoder window, and a large model on a weak
 * CPU (the GPU is off on Intel-only darwin-x64) can take minutes per window.
 * The budget exists ONLY to unwedge a genuinely stuck synchronous addon call —
 * a hopelessly slow (but progressing) cadence is the local lane's per-recording
 * circuit breaker's job, not this timeout's.
 */
export const TRANSCRIBE_TIMEOUT = Duration.seconds(300);
/** Loading large-v3 (3 GB) from a cold disk plus the darwin-x64 GPU probe (≤5 s). */
export const MODEL_LOAD_TIMEOUT = Duration.minutes(3);

export interface WhisperWorkerPaths {
  readonly nodeBinaryPath: string;
  readonly workerPath: string;
  readonly cwd: string;
  /** Packaged only — exported to the worker as APP_ASAR_PATH. */
  readonly asarPath?: string;
}

/**
 * The runtime path resolution above, from AppConfig (testable without electron:
 * `process.resourcesPath` is only read when packaged).
 */
export const resolveWhisperWorkerPaths = (config: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
}): WhisperWorkerPaths => {
  const binary = config.platform === 'win32' ? 'node.exe' : 'node';
  if (config.isPackaged) {
    const resources = process.resourcesPath;
    return {
      nodeBinaryPath: path.join(resources, binary),
      workerPath: path
        .join(__dirname, 'whisper-worker-fork.js')
        .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
      cwd: resources,
      asarPath: path.join(resources, 'app.asar'),
    };
  }
  return {
    nodeBinaryPath: path.join(
      process.cwd(),
      'node-binaries',
      `${config.platform}-${process.arch}`,
      binary
    ),
    workerPath: path.join(process.cwd(), '.vite', 'build', 'whisper-worker-fork.js'),
    cwd: process.cwd(),
  };
};

/** Injectable `fork` (mirrors transport's FetchLike) so the host is unit-testable with a fake child. */
export type ForkLike = (
  modulePath: string,
  args: readonly string[],
  options: ForkOptions
) => ChildProcess;

export interface WhisperEngineLiveOptions {
  /** Override the path resolution (the integration test + eval harnesses). */
  readonly paths?: WhisperWorkerPaths;
  readonly forkFn?: ForkLike;
  readonly transcribeTimeout?: Duration.Duration;
  readonly modelLoadTimeout?: Duration.Duration;
}

type Resume = (result: Effect.Effect<unknown, WhisperEngineError>) => void;

interface WorkerHandle {
  readonly child: ChildProcess;
  readonly pending: Map<number, Resume>;
  nextId: number;
  /** True once the worker sent ANY message (its boot log frame): a death before that is a spawn failure. */
  ready: boolean;
  /** The model this worker holds; null after fork and after `dispose`. */
  loadedModelPath: string | null;
  dead: boolean;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makeWhisperEngineLive = (
  options: WhisperEngineLiveOptions = {}
): Layer.Layer<
  WhisperEngine,
  never,
  AppConfig | MainLogger | LoggingTransport | TelemetryService
> =>
  Layer.scoped(
    WhisperEngine,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const logger = yield* MainLogger;
      const transport = yield* LoggingTransport;
      const reportFailure = yield* makeProcessFailureReporter(
        yield* TelemetryService,
        logger.scopedSync('whisper-engine')
      );
      const log = logger.scoped('whisper-engine');
      const unsafeLog = logger.scopedSync('whisper-engine');
      const paths = options.paths ?? resolveWhisperWorkerPaths(config);
      const forkFn: ForkLike = options.forkFn ?? fork;
      const transcribeTimeout = options.transcribeTimeout ?? TRANSCRIBE_TIMEOUT;
      const modelLoadTimeout = options.modelLoadTimeout ?? MODEL_LOAD_TIMEOUT;
      const semaphore = yield* Effect.makeSemaphore(1);

      // Callback-edge state (single-threaded event loop): mutated only under the
      // semaphore or inside the child's event handlers, read via Effect.suspend/sync.
      let worker: WorkerHandle | null = null;
      // The model the lane last asked for — re-loaded transparently after a crash.
      let requestedModelPath: string | null = null;

      const settleAll = (handle: WorkerHandle, error: WhisperEngineError): void => {
        const waiters = [...handle.pending.values()];
        handle.pending.clear();
        for (const resume of waiters) resume(Effect.fail(error));
      };

      /** Idempotent: the `error` and `exit` edges (and a deliberate kill) all land here. */
      const markDead = (handle: WorkerHandle, detail: string): void => {
        if (handle.dead) return;
        handle.dead = true;
        handle.loadedModelPath = null;
        if (worker === handle) worker = null;
        settleAll(
          handle,
          new WhisperEngineError({
            reason: handle.ready ? 'worker-crashed' : 'spawn-failed',
            detail,
          })
        );
      };

      const onMessage = (handle: WorkerHandle, msg: unknown): void => {
        handle.ready = true;
        if (isWorkerLogFrame(msg)) {
          const frame = parseWire(msg);
          if (frame)
            transport.ingest(frame, { runtime: 'worker', pid: handle.child.pid ?? process.pid });
          return;
        }
        if (typeof msg !== 'object' || msg === null) return;
        const response = msg as WorkerResponse;
        if (typeof response.id !== 'number') return;
        const resume = handle.pending.get(response.id);
        if (resume === undefined) return; // timed out / interrupted — already settled
        handle.pending.delete(response.id);
        resume(
          response.error !== undefined
            ? Effect.fail(
                new WhisperEngineError({ reason: 'inference-failed', detail: response.error })
              )
            : Effect.succeed(response.result)
        );
      };

      const spawnWorker: Effect.Effect<WorkerHandle, WhisperEngineError> = Effect.gen(function* () {
        const child = yield* Effect.try({
          try: () =>
            forkFn(paths.workerPath, [], {
              execPath: paths.nodeBinaryPath,
              execArgv: [],
              cwd: paths.cwd,
              silent: true,
              env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                NODE_ENV: config.isPackaged ? 'production' : 'development',
                DESKTOP_APP_RUN_ID: logger.appRunId,
                NODE_OPTIONS: '--max-old-space-size=8192',
                ...(paths.asarPath === undefined ? {} : { APP_ASAR_PATH: paths.asarPath }),
              },
            }),
          catch: cause => {
            reportFailure(cause);
            return new WhisperEngineError({ reason: 'spawn-failed', detail: errorMessage(cause) });
          },
        });
        const handle: WorkerHandle = {
          child,
          pending: new Map(),
          nextId: 0,
          ready: false,
          loadedModelPath: null,
          dead: false,
        };
        child.on('message', msg => onMessage(handle, msg));
        child.on('error', error => {
          if (!handle.dead) reportFailure(error);
          if (!handle.dead)
            unsafeLog.error('Whisper worker failed', { context: { workerPid: child.pid }, error });
          markDead(handle, error.message);
        });
        child.on('exit', (code, signal) => {
          if (!handle.dead)
            reportFailure(
              new WhisperEngineError({
                reason: handle.ready ? 'worker-crashed' : 'spawn-failed',
                detail: 'Worker exited unexpectedly',
              }),
              { exit_code: code }
            );
          if (!handle.dead)
            unsafeLog.error('Whisper worker exited unexpectedly', {
              context: { code, signal, workerPid: child.pid, pendingRequests: handle.pending.size },
            });
          markDead(handle, `exit code=${code} signal=${signal}`);
        });
        for (const stream of [child.stdout, child.stderr]) {
          const diagnostics = makeProcessDiagnostics(
            transport,
            () => ({ runtime: 'worker', pid: child.pid ?? process.pid }),
            'whisper-worker'
          );
          stream?.on('data', diagnostics.push);
          stream?.on('end', diagnostics.end);
        }
        worker = handle;
        yield* log.info('whisper worker forked');
        return handle;
      });

      const ensureWorker: Effect.Effect<WorkerHandle, WhisperEngineError> = Effect.suspend(() =>
        worker === null ? spawnWorker : Effect.succeed(worker)
      );

      const killWorker = (why: string): Effect.Effect<void> =>
        Effect.sync(() => {
          const handle = worker;
          if (handle === null) return;
          markDead(handle, why);
          handle.child.kill();
          unsafeLog.info('Whisper worker stopped', {
            context: { reason: why, workerPid: handle.child.pid },
          });
        });

      /** One request/response exchange; interruption (timeout) forgets the call. */
      const exec = <T>(
        handle: WorkerHandle,
        method: string,
        args: readonly unknown[]
      ): Effect.Effect<T, WhisperEngineError> =>
        Effect.async<T, WhisperEngineError>(resume => {
          if (handle.dead) {
            resume(
              Effect.fail(
                new WhisperEngineError({ reason: 'worker-crashed', detail: 'worker is gone' })
              )
            );
            return;
          }
          const id = handle.nextId++;
          handle.pending.set(id, result => resume(result as Effect.Effect<T, WhisperEngineError>));
          const request: WorkerRequest = { id, method, args: args.map(serializeArg) };
          try {
            handle.child.send(request);
          } catch (cause) {
            handle.pending.delete(id);
            resume(
              Effect.fail(
                new WhisperEngineError({ reason: 'worker-crashed', detail: errorMessage(cause) })
              )
            );
          }
          return Effect.sync(() => {
            handle.pending.delete(id);
          });
        });

      /** Budget a call; a timeout kills the (presumed stuck) worker so the next call re-forks. */
      const budgeted = <T>(
        effect: Effect.Effect<T, WhisperEngineError>,
        budget: Duration.Duration,
        what: string
      ): Effect.Effect<T, WhisperEngineError> =>
        effect.pipe(
          Effect.timeoutFail({
            duration: budget,
            onTimeout: () => new WhisperEngineError({ reason: 'timeout', detail: what }),
          }),
          Effect.tapError(error =>
            error.reason === 'timeout'
              ? log
                  .warn('whisper worker call timed out — replacing the worker', {
                    context: { what },
                  })
                  .pipe(Effect.zipRight(killWorker(`timeout: ${what}`)))
              : Effect.void
          )
        );

      const ensureLoaded = (modelPath: string): Effect.Effect<WorkerHandle, WhisperEngineError> =>
        Effect.gen(function* () {
          const handle = yield* ensureWorker;
          if (handle.loadedModelPath === modelPath) return handle;
          // The worker frees the PREVIOUS model before attempting the new one
          // (whisper-worker-fork.ts initializeModel), so a failed SWITCH leaves
          // it model-less. Forget the cached path BEFORE the attempt and record
          // the new one only on success — otherwise a failed switch would leave
          // the host believing the old model is loaded and decode against a
          // freed instance for the rest of the boot scope.
          handle.loadedModelPath = null;
          yield* budgeted(
            exec<void>(handle, 'initializeModel', [modelPath]),
            modelLoadTimeout,
            'initializeModel'
          );
          handle.loadedModelPath = modelPath;
          yield* log.info('whisper model loaded', { context: { model: path.basename(modelPath) } });
          return handle;
        });

      const api: WhisperEngineApi = {
        ensureModel: modelPath =>
          semaphore.withPermits(1)(
            Effect.suspend(() => {
              requestedModelPath = modelPath;
              return ensureLoaded(modelPath).pipe(Effect.asVoid);
            })
          ),
        transcribe: (audio16k, decodeOptions) =>
          semaphore.withPermits(1)(
            Effect.suspend(() => {
              const modelPath = requestedModelPath;
              if (modelPath === null) {
                return Effect.fail(
                  new WhisperEngineError({
                    reason: 'inference-failed',
                    detail: 'no model requested — call ensureModel first',
                  })
                );
              }
              return ensureLoaded(modelPath).pipe(
                Effect.flatMap(handle =>
                  budgeted(
                    exec<WorkerTranscription>(handle, 'transcribeAudio', [audio16k, decodeOptions]),
                    transcribeTimeout,
                    'transcribeAudio'
                  )
                )
              );
            })
          ),
        // Deliberately NOT under the semaphore: a stuck decode must not delay a kill.
        dispose: killWorker('dispose'),
      };

      yield* Effect.addFinalizer(() => killWorker('scope closed'));
      return api;
    })
  );

/** The boot-scoped host with the runtime path resolution (BootLayer). */
export const WhisperEngineLive: Layer.Layer<
  WhisperEngine,
  never,
  AppConfig | MainLogger | LoggingTransport | TelemetryService
> = makeWhisperEngineLive();
