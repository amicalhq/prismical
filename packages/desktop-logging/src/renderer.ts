import { byteLength, formatConsole, makeWire } from './codec';
import { makeFilter } from './filter';
import { LIMITS, type Level, type LogWire } from './types';

type FilterConfig = Parameters<typeof makeFilter>[0];
export interface RendererLogBridge {
  getConfig(): Promise<FilterConfig | null>;
  write(frame: LogWire): Promise<unknown>;
}

/** One console/failure adapter. Unsettled IPC stays inside the queue budget. */
export function installRendererLogBridge(bridge: RendererLogBridge, scope: string): () => void {
  const original = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const queue: Array<{ frame: LogWire; bytes: number; notice: boolean }> = [];
  const reported = new WeakSet<object>();
  let filter = makeFilter({ isDev: false });
  let configured = false;
  let disposed = false;
  let draining = false;
  let bytes = 0;
  let dropped = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const display = (frame: LogWire) => {
    if (filter.enabled(frame.level, frame.scope, 'console'))
      original[frame.level].call(console, formatConsole(frame));
  };
  const notice = () => {
    const frame = makeWire('warn', scope, 'Renderer log records suppressed', {
      context: { count: dropped },
    });
    dropped = 0;
    display(frame);
    return frame;
  };
  const drain = async () => {
    if (!configured || disposed || draining) return;
    draining = true;
    try {
      while (!disposed && (queue.length || dropped)) {
        if (!queue.length) {
          const frame = notice();
          const size = byteLength(JSON.stringify(frame));
          queue.push({ frame, bytes: size, notice: true });
          bytes += size;
        }
        const item = queue[0]!;
        try {
          if (
            filter.enabled(item.frame.level, scope, 'file') ||
            filter.enabled(item.frame.level, scope, 'console')
          ) {
            // Do not race a timeout: Electron invoke cannot be cancelled. Keep
            // this entry counted until the actual call settles, even when hung.
            if ((await bridge.write(item.frame)) === false && !item.notice) dropped++;
          }
        } catch {
          if (!item.notice) dropped++;
        } finally {
          if (!disposed) {
            queue.shift();
            bytes -= item.bytes;
          }
        }
      }
    } finally {
      draining = false;
    }
  };
  const enqueue = (frame: LogWire) => {
    if (disposed) return;
    // DevTools must still work before config arrives or while IPC is stalled.
    display(frame);
    const size = byteLength(JSON.stringify(frame));
    if (queue.length >= LIMITS.queueRecords || bytes + size > LIMITS.queueBytes) {
      dropped++;
      return;
    }
    queue.push({ frame, bytes: size, notice: false });
    bytes += size;
    void drain().catch(() => {});
  };
  const alreadyReported = (error: unknown) => {
    if (error === null || typeof error !== 'object') return false;
    if (reported.has(error)) return true;
    reported.add(error);
    return false;
  };
  const emit =
    (level: Level) =>
    (...args: unknown[]) => {
      if (
        disposed ||
        (configured &&
          !filter.enabled(level, scope, 'file') &&
          !filter.enabled(level, scope, 'console'))
      )
        return;
      try {
        const error = args.find(value => value instanceof Error);
        if (level === 'error' && error && alreadyReported(error)) return;
        enqueue(
          makeWire(level, scope, typeof args[0] === 'string' ? args[0] : 'Renderer diagnostic', {
            context: { argumentCount: args.length },
            error,
          })
        );
      } catch {
        /* Exotic arguments must not break application work. */
      }
    };
  console.debug = emit('debug');
  console.info = console.log = emit('info');
  console.warn = emit('warn');
  console.error = emit('error');
  const failure = (message: string, error: unknown) => {
    if (!alreadyReported(error)) enqueue(makeWire('error', scope, message, { error }));
  };
  const onError = (event: ErrorEvent) => failure('Renderer uncaught exception', event.error);
  const onRejection = (event: PromiseRejectionEvent) =>
    failure('Renderer unhandled rejection', event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const initialize = async () => {
    try {
      const next = await bridge.getConfig();
      if (disposed) return;
      if (!next) throw new Error('Logging source unavailable');
      filter = makeFilter(next);
      configured = true;
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
    if (dropped) notice();
    queue.length = 0;
    bytes = 0;
    Object.assign(console, original);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
