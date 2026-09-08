import {
  makeWire,
  makeRecord,
  makeFilter,
  formatConsole,
  byteLength,
  LIMITS,
  type Level,
  type LogMetadata,
  type LogWire,
} from '@desktop/logging/wire';
import type { DesktopLoggingApi, RendererLoggingConfig } from '@prismical/desktop-contracts';

/** One boot-owned boundary. Console's legacy variadic shape stops here: only a
 * sanitized wire record reaches DevTools or the main-process transport. */
export function installRendererLogging(api: DesktopLoggingApi): () => void {
  const original = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  let config: RendererLoggingConfig | undefined;
  let filter: ReturnType<typeof makeFilter> | undefined;
  let disposed = false;
  let draining = false;
  let dropped = 0;
  let bytes = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const queue: LogWire[] = [];
  const reported = new WeakSet<object>();
  const drain = async (): Promise<void> => {
    if (draining || !config || !filter || disposed) return;
    draining = true;
    try {
      while ((queue.length || dropped) && !disposed) {
        const notice = queue.length === 0;
        const wire = notice
          ? makeWire('warn', 'renderer', 'Renderer log records suppressed', {
              context: { count: dropped },
            })
          : queue.shift()!;
        if (notice) dropped = 0;
        else bytes -= byteLength(JSON.stringify(wire));
        const fileEnabled = filter.enabled(wire.level, wire.scope, 'file');
        const consoleEnabled = filter.enabled(wire.level, wire.scope, 'console');
        if (consoleEnabled)
          original[wire.level].call(
            console,
            formatConsole(
              makeRecord(
                wire,
                {
                  app: 'prismical',
                  appVersion: config.appVersion,
                  appRunId: config.appRunId,
                  ...(config.buildId ? { buildId: config.buildId } : {}),
                },
                { runtime: 'renderer', pid: config.pid, surface: config.surface }
              )
            )
          );
        if (!fileEnabled && !consoleEnabled) continue;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            api.write(wire),
            new Promise<void>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Logging IPC timeout')), 3000);
            }),
          ]);
        } catch {
          if (!notice) dropped += 1;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } finally {
      draining = false;
    }
  };
  const enqueue = (wire: LogWire): void => {
    if (disposed) return;
    const size = byteLength(JSON.stringify(wire));
    if (queue.length >= LIMITS.queueRecords || bytes + size > LIMITS.queueBytes) {
      dropped += 1;
      return;
    }
    queue.push(wire);
    bytes += size;
    void drain().catch(() => {
      /* Diagnostics never reject product work. */
    });
  };
  const emit =
    (level: Level) =>
    (...args: unknown[]): void => {
      try {
        if (
          filter &&
          !filter.enabled(level, 'renderer', 'file') &&
          !filter.enabled(level, 'renderer', 'console')
        )
          return;
        const error = args.find(value => value instanceof Error);
        if (error) {
          if (reported.has(error)) return;
          reported.add(error);
        }
        const message = typeof args[0] === 'string' ? args[0] : 'Renderer diagnostic';
        // Arbitrary console objects can contain application state or user content.
        // Keep an actual Error projection and argument counts, never dump the rest.
        const metadata: LogMetadata = {
          ...(error ? { error } : {}),
          ...(args.length > 1 ? { context: { argumentCount: args.length } } : {}),
        };
        enqueue(makeWire(level, 'renderer', message, metadata));
      } catch {
        /* Getters and exotic console arguments must not break callers. */
      }
    };
  console.debug = emit('debug');
  console.info = console.log = emit('info');
  console.warn = emit('warn');
  console.error = emit('error');
  const reportFailure = (message: string, error: unknown): void => {
    if (error !== null && typeof error === 'object') {
      if (reported.has(error)) return;
      reported.add(error);
    }
    enqueue(makeWire('error', 'renderer', message, { error }));
  };
  const onError = (event: ErrorEvent) => reportFailure('Renderer uncaught exception', event.error);
  const onRejection = (event: PromiseRejectionEvent) =>
    reportFailure('Renderer unhandled rejection', event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const initialize = async (): Promise<void> => {
    try {
      const next = await api.getConfig();
      if (disposed) return;
      config = next;
      filter = makeFilter(next);
      await drain();
    } catch {
      if (!disposed)
        retry = setTimeout(() => {
          void initialize();
        }, 1000);
    }
  };
  void initialize();
  return () => {
    disposed = true;
    if (retry) clearTimeout(retry);
    queue.length = 0;
    Object.assign(console, original);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
