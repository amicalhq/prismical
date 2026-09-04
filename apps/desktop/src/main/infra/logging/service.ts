import { Context, type Effect } from 'effect';

export interface ScopedLog {
  readonly debug: (message: string, data?: unknown) => Effect.Effect<void>;
  readonly info: (message: string, data?: unknown) => Effect.Effect<void>;
  readonly warn: (message: string, data?: unknown) => Effect.Effect<void>;
  readonly error: (message: string, data?: unknown) => Effect.Effect<void>;
}

/** Plain-function variant for Electron callback edges (event handlers, IPC
 * bridges) where no fiber is running. Same scopes, same redaction. */
export interface UnsafeScopedLog {
  readonly debug: (message: string, data?: unknown) => void;
  readonly info: (message: string, data?: unknown) => void;
  readonly warn: (message: string, data?: unknown) => void;
  readonly error: (message: string, data?: unknown) => void;
}

export interface MainLoggerService {
  readonly scoped: (scope: string) => ScopedLog;
  readonly scopedUnsafe: (scope: string) => UnsafeScopedLog;
}

export class MainLogger extends Context.Tag('desktop/MainLogger')<MainLogger, MainLoggerService>() {}
