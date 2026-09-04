/**
 * Test layers: AppConfig fixtures and a capturing MainLogger (so tests can
 * assert warn/release log lines without electron-log noise).
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { createApplicationI18nSync, type SupportedLocale } from '@prismical/app-i18n';
import { DesktopI18n } from '../../src/main/domains/i18n/service';
import type { RecordingLaneResult } from '../../src/main/domains/transport/service';
import { AppConfig, type AppConfigService } from '../../src/main/infra/config/service';
import {
  MainLogger,
  type MainLoggerService,
  type ScopedLog,
  type UnsafeScopedLog,
} from '../../src/main/infra/logging/service';
import { redactValue } from '../../src/main/infra/logging/redact';

export const testConfig = (overrides: Partial<AppConfigService> = {}): AppConfigService => ({
  // Recovery WAVs follow the (possibly overridden) profile dir, as in the real config.
  recoveryDir: path.join(overrides.userDataDir ?? '/fake/user-data', 'recovery'),
  isPackaged: false,
  isE2E: false,
  secureStoreMode: 'safeStorage',
  e2eFakeAi: false,
  platform: process.platform,
  appVersion: '0.0.0-test',
  userDataDir: '/fake/user-data',
  operationalDbPath: ':memory:',
  localDbPath: ':memory:',
  // Never created unless a test opens a cloud-cache target (mkdir happens at open).
  cloudCacheDir: path.join(tmpdir(), 'prismical-test-cloud-cache'),
  // Never created unless a test downloads a model (mkdir happens on first download).
  modelsDir: path.join(tmpdir(), 'prismical-test-models'),
  rendererDevServerUrl: null,
  endpoints: {
    coreApiUrl: 'https://core.test',
    noteWsUrl: 'wss://note.test/collaboration',
    webAppOrigin: 'https://app.test',
    analyticsKey: null,
    analyticsHost: null,
  },
  auth: {
    oauthClientId: 'test-desktop-client',
    redirectUri: 'prismical-dev://oauth/callback',
    authorizeUrl: 'https://core.test/api/auth/oauth2/authorize',
    tokenUrl: 'https://core.test/api/auth/oauth2/token',
    revokeUrl: 'https://core.test/api/auth/oauth2/revoke',
    jwksUrl: 'https://core.test/api/auth/jwks',
    issuer: 'https://core.test/api/auth',
  },
  updaterEnabled: false,
  ...overrides,
});

export const testConfigLayer = (overrides: Partial<AppConfigService> = {}) =>
  Layer.succeed(AppConfig, testConfig(overrides));

export const testI18nLayer = (locale: SupportedLocale = 'en') => {
  const instance = createApplicationI18nSync(locale);
  return Layer.succeed(DesktopI18n, {
    locale,
    systemLocale: locale,
    t: instance.t,
  });
};

/**
 * The recording-lane methods (create / transcribe-chunk / finalize) as inert
 * stubs — for WorkspaceBackendApi test doubles that exercise only request/openAskStream/
 * collabToken. Every method resolves to an inert non-retryable failure so a stray
 * call is a no-op, never a real fetch. Spread into a WorkspaceBackendApi literal to satisfy
 * the interface: `{ request, openAskStream, collabToken, ...recordingLaneStub }`.
 * (`RecordingLaneResult<never>` is assignable to every concrete `RecordingLaneResult<T>`.)
 */
export const recordingLaneStub = {
  createRecording: () =>
    Effect.succeed<RecordingLaneResult<never>>({
      ok: false,
      retryable: false,
      failure: { kind: 'stale-identity' },
    }),
  uploadTranscriptionChunk: () =>
    Effect.succeed<RecordingLaneResult<never>>({
      ok: false,
      retryable: false,
      failure: { kind: 'stale-identity' },
    }),
  finalizeRecording: () =>
    Effect.succeed<RecordingLaneResult<never>>({
      ok: false,
      retryable: false,
      failure: { kind: 'stale-identity' },
    }),
  stageRecordingAudio: () =>
    Effect.succeed<RecordingLaneResult<never>>({
      ok: false,
      retryable: false,
      failure: { kind: 'stale-identity' },
    }),
  abandonRecordingStaging: () =>
    Effect.succeed<RecordingLaneResult<never>>({
      ok: false,
      retryable: false,
      failure: { kind: 'stale-identity' },
    }),
};

export interface LogEntry {
  readonly scope: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data: unknown;
}

export interface TestLogger {
  readonly entries: LogEntry[];
  readonly layer: Layer.Layer<MainLogger>;
  readonly find: (predicate: (entry: LogEntry) => boolean) => LogEntry | undefined;
}

export const makeTestLogger = (): TestLogger => {
  const entries: LogEntry[] = [];
  const unsafe = (scope: string): UnsafeScopedLog => {
    const emit =
      (level: LogEntry['level']) =>
      (message: string, data?: unknown): void => {
        entries.push({ scope, level, message, data: redactValue(data) });
      };
    return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
  };
  const scoped = (scope: string): ScopedLog => {
    const raw = unsafe(scope);
    return {
      debug: (message, data) => Effect.sync(() => raw.debug(message, data)),
      info: (message, data) => Effect.sync(() => raw.info(message, data)),
      warn: (message, data) => Effect.sync(() => raw.warn(message, data)),
      error: (message, data) => Effect.sync(() => raw.error(message, data)),
    };
  };
  const service: MainLoggerService = { scoped, scopedUnsafe: unsafe };
  return {
    entries,
    layer: Layer.succeed(MainLogger, service),
    find: predicate => entries.find(predicate),
  };
};
