/**
 * Effect logger bridged onto the existing electron-log module (src/main/logger.ts)
 * so scope names stay exactly as the native modules expect
 * (main/audio/transcription/…). Every structured value passes through redactValue.
 */
import { Effect, Layer } from 'effect';
import { createScopedLogger } from '../../logger';
import { redactValue } from './redact';
import { MainLogger, type MainLoggerService, type ScopedLog, type UnsafeScopedLog } from './service';

type Level = 'debug' | 'info' | 'warn' | 'error';

const makeUnsafe = (scope: string): UnsafeScopedLog => {
  const log = createScopedLogger(scope);
  const emit =
    (level: Level) =>
    (message: string, data?: unknown): void => {
      if (data === undefined) log[level](message);
      else log[level](message, redactValue(data));
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
};

const toEffectful = (unsafe: UnsafeScopedLog): ScopedLog => ({
  debug: (message, data) => Effect.sync(() => unsafe.debug(message, data)),
  info: (message, data) => Effect.sync(() => unsafe.info(message, data)),
  warn: (message, data) => Effect.sync(() => unsafe.warn(message, data)),
  error: (message, data) => Effect.sync(() => unsafe.error(message, data)),
});

export const makeMainLogger = (): MainLoggerService => {
  // electron-log memoizes scopes internally; cache the wrappers alongside.
  const cache = new Map<string, { scoped: ScopedLog; unsafe: UnsafeScopedLog }>();
  const entry = (scope: string) => {
    let found = cache.get(scope);
    if (!found) {
      const unsafe = makeUnsafe(scope);
      found = { scoped: toEffectful(unsafe), unsafe };
      cache.set(scope, found);
    }
    return found;
  };
  return {
    scoped: scope => entry(scope).scoped,
    scopedUnsafe: scope => entry(scope).unsafe,
  };
};

export const MainLoggerLive: Layer.Layer<MainLogger> = Layer.effect(
  MainLogger,
  Effect.sync(makeMainLogger)
);
