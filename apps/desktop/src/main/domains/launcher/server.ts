import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Deferred, Effect, FiberSet, Stream, type Scope } from 'effect';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { RecordingBridge } from '../recording/bridge';
import { idleRecordingState } from '../recording/service';
import {
  bindLauncherWindow,
  cancelLauncherIntent,
  forgetLauncherWindow,
  type LauncherIntent,
} from './intent';
import { FloatBridge } from '../windows/float-bridge';

export const launcherCommands = ['start-recording', 'stop-recording'] as const;
export function parseLauncherRequest(req: Pick<IncomingMessage, 'method' | 'url' | 'headers'>) {
  if (req.headers.origin || req.headers['sec-fetch-site']) return null;
  if (req.method === 'GET' && req.url === '/status') return 'status';
  if (req.method !== 'POST') return null;
  return launcherCommands.find(command => req.url === `/${command}`) ?? null;
}

/** Same-user IPC only. No TCP listener, credential sharing or recording action URLs. */
export const runLauncherServer: Effect.Effect<
  void,
  never,
  AppConfig | MainLogger | RecordingBridge | FloatBridge | Scope.Scope
> = Effect.gen(function* () {
  const config = yield* AppConfig;
  if (config.platform !== 'darwin') return;
  const log = (yield* MainLogger).scoped('launcher');
  const recording = yield* RecordingBridge;
  const floating = yield* FloatBridge;
  const run = yield* FiberSet.makeRuntimePromise<Scope.Scope>();
  const bootId = randomUUID();
  let state = idleRecordingState;
  let pending: LauncherIntent | null = null;
  const clear = () => {
    pending = null;
  };
  const closeOwned = (intent: LauncherIntent) =>
    Effect.sync(() => {
      cancelLauncherIntent(intent);
      // The typed renderer intent is revoked before native work is interrupted.
      // Preserve the note/window: already-dispatched note creation can finish safely.
    });
  const cancel = Effect.gen(function* () {
    const intent = pending;
    clear();
    if (intent && !intent.finished) yield* closeOwned(intent);
    yield* recording.stopActive;
  });
  yield* Effect.forkScoped(
    recording.stateChanges.pipe(
      Stream.runForEach(value =>
        Effect.sync(() => {
          state = value;
        })
      )
    )
  );
  const directory = path.join(config.userDataDir, 'launcher');
  const socketPath = path.join(directory, 'raycast.sock');
  const prepared = yield* Effect.tryPromise(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
      throw new Error('Unsafe launcher directory');
    await chmod(directory, 0o700);
    try {
      const socket = await lstat(socketPath);
      if (!socket.isSocket() || socket.uid !== process.getuid?.())
        throw new Error('Unsafe launcher socket');
      await unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }).pipe(Effect.result);
  if (prepared._tag === 'Failure') {
    yield* log.warn('launcher socket unavailable');
    return;
  }

  const status = Effect.gen(function* () {
    const context = yield* recording.launcherContext;
    return {
      protocolVersion: 1,
      appVersion: config.appVersion,
      capabilities: launcherCommands,
      session: `${bootId}:${context.generation}`,
      ready: context.ready,
      recordingStatus: state.status,
    };
  });
  const execute = (
    command: (typeof launcherCommands)[number],
    requestId: string,
    session: string,
    expires: number
  ) =>
    Effect.gen(function* () {
      const context = yield* recording.launcherContext;
      if (session !== `${bootId}:${context.generation}` || expires <= Date.now())
        return {
          ok: false,
          message: 'Prismical changed workspace or recording state. Try the command again.',
        };
      if (command === 'stop-recording') {
        yield* cancel;
        return { ok: true, message: 'Stop requested. Check Prismical.', ...(yield* status) };
      }
      if (!context.ready)
        return { ok: false, message: 'Open Prismical, select your workspace, and try again.' };
      if (['starting', 'recording', 'paused', 'stopping'].includes(state.status)) {
        const shown = yield* floating.open(state.noteId);
        return {
          ok: shown,
          message: shown
            ? 'Showing the active recording'
            : 'Recording is active. Open Prismical to view it.',
        };
      }
      if (pending && (pending.finished || pending.generation !== context.generation)) {
        cancelLauncherIntent(pending);
        clear();
      }
      if (pending) {
        // Reveal the existing window without issuing another fresh-note intent.
        if (pending.windowId !== undefined && !(yield* floating.open(pending.noteId ?? null)))
          return {
            ok: false,
            message: 'Recording was already requested. Open Prismical to check it.',
          };
        return { ok: true, message: 'Recording already requested. Check Prismical.' };
      }
      const intent: LauncherIntent = {
        id: requestId,
        generation: context.generation,
        expires,
        canceled: yield* Deferred.make<void>(),
        claimed: false,
        finished: false,
      };
      pending = intent;
      yield* Effect.forkScoped(
        Effect.sleep(Math.max(1, expires - Date.now())).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (pending !== intent || intent.finished) return;
              clear();
              cancelLauncherIntent(intent);
            })
          ),
          Effect.raceFirst(Deferred.await(intent.canceled))
        )
      );
      const canOpen = Effect.gen(function* () {
        const current = yield* recording.launcherContext;
        return (
          pending === intent &&
          Date.now() < expires &&
          current.ready &&
          current.generation === intent.generation
        );
      });
      const opened = yield* floating.open(null, {
        fresh: true,
        autoStart: true,
        canOpen,
        launcherIntent: intent.id,
        onWindow: contents => {
          if (intent.windowId === contents.id) return;
          bindLauncherWindow(intent, contents.id);
          contents.once('destroyed', () => {
            forgetLauncherWindow(contents.id);
            cancelLauncherIntent(intent);
            if (pending === intent) clear();
          });
        },
      });
      if (!opened) {
        cancelLauncherIntent(intent);
        if (pending === intent) clear();
        return {
          ok: false,
          message: 'Recording was not started. Open Prismical to check setup and permissions.',
        };
      }
      return { ok: true, message: 'Recording requested. Check Prismical.' };
    });
  const responses = new Map<string, { expires: number; value: Promise<unknown> }>();
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    const command = parseLauncherRequest(req);
    const id = req.headers['x-request-id'];
    const expires = Number(req.headers['x-expires-at']);
    const session = req.headers['x-session'];
    if (
      !command ||
      (command !== 'status' &&
        (typeof id !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(id) ||
          !Number.isSafeInteger(expires) ||
          expires <= Date.now() ||
          expires > Date.now() + 30_000 ||
          typeof session !== 'string'))
    ) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, message: 'Invalid or expired command' }));
      return;
    }
    const key = `${command}:${id}`;
    for (const [key, value] of responses) if (value.expires < Date.now()) responses.delete(key);
    let result = command === 'status' ? run(status) : responses.get(key)?.value;
    if (!result) {
      if (responses.size >= 128 && command !== 'stop-recording') {
        res.writeHead(429);
        res.end(JSON.stringify({ ok: false, message: 'Too many commands. Try again shortly.' }));
        return;
      }
      result = run(
        execute(
          command as (typeof launcherCommands)[number],
          id as string,
          session as string,
          expires
        )
      );
      // Stop must remain available under a burst of hotkeys. If the bounded
      // cache is full, its session generation still prevents a delayed duplicate
      // Stop from affecting a recording started after the first Stop.
      if (responses.size < 128) responses.set(key, { expires: Date.now() + 60_000, value: result });
    }
    void result
      .then(value => {
        res.writeHead(200);
        res.end(JSON.stringify(value));
      })
      .catch(() => {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, message: 'Check Prismical before trying again.' }));
      });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (pending) cancelLauncherIntent(pending);
      clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    })
  );
  const listened = yield* Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          void chmod(socketPath, 0o600).then(resolve, reject);
        });
      })
  ).pipe(Effect.result);
  if (listened._tag === 'Failure') yield* log.warn('launcher socket could not listen');
  else yield* log.info('launcher socket ready');
});
