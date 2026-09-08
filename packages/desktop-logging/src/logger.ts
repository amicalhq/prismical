import { Effect } from "effect";
import { makeRecord, makeWire, parseWire } from "./codec";
import type { LogFilter } from "./filter";
import type {
  Level,
  LogMetadata,
  LogOrigin,
  LogRecord,
  LogSource,
  MainLoggerService,
  ScopedLog,
  SyncScopedLog,
} from "./types";

export interface Destinations {
  readonly file: boolean;
  readonly console: boolean;
}
export function makeLogger(
  write: (record: LogRecord, destinations: Destinations) => void,
  config: { origin: LogOrigin; source: LogSource; filter: LogFilter },
): {
  service: MainLoggerService;
  ingest: (input: unknown, source: LogSource) => boolean;
  isEnabled: (level: Level, scope: string) => boolean;
} {
  const destinations = (level: Level, scope: string): Destinations => ({
    file: config.filter.enabled(level, scope, "file"),
    console: config.filter.enabled(level, scope, "console"),
  });
  const isEnabled = (level: Level, scope: string) => {
    const targets = destinations(level, scope);
    return targets.file || targets.console;
  };
  const ingest = (input: unknown, source: LogSource): boolean => {
    try {
      const wire = parseWire(input);
      if (!wire) return false;
      const targets = destinations(wire.level, wire.scope);
      if (targets.file || targets.console)
        write(makeRecord(wire, config.origin, source), targets);
      return true;
    } catch {
      return false;
    }
  };
  const scopedSync = (scope: string): SyncScopedLog => {
    const emit =
      (level: Level) =>
      (message: string, metadata?: LogMetadata): void => {
        try {
          if (!isEnabled(level, scope)) return;
          const record = makeRecord(
            makeWire(level, scope, message, metadata),
            config.origin,
            config.source,
          );
          write(record, destinations(level, scope));
        } catch {
          /* App-owned writers can emit emergency evidence; never recurse. */
        }
      };
    return {
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
    };
  };
  const scoped = (scope: string): ScopedLog => {
    const sync = scopedSync(scope);
    return {
      debug: (message, metadata) =>
        Effect.sync(() => sync.debug(message, metadata)),
      info: (message, metadata) =>
        Effect.sync(() => sync.info(message, metadata)),
      warn: (message, metadata) =>
        Effect.sync(() => sync.warn(message, metadata)),
      error: (message, metadata) =>
        Effect.sync(() => sync.error(message, metadata)),
    };
  };
  return {
    service: { appRunId: config.origin.appRunId, scoped, scopedSync },
    ingest,
    isEnabled,
  };
}
