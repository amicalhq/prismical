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
import { MainLogger, LoggingTransport } from '../../src/main/infra/logging/service';
import { makeLogger, makeFilter, type LogRecord } from '@desktop/logging';

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
};

export interface LogEntry {
  readonly scope: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data: unknown;
  readonly runtime?: string;
  readonly pid?: number;
  readonly error?: LogRecord['error'];
}

export interface TestLogger {
  readonly entries: LogEntry[];
  readonly layer: Layer.Layer<MainLogger | LoggingTransport>;
  readonly find: (predicate: (entry: LogEntry) => boolean) => LogEntry | undefined;
}

export const makeTestLogger = (): TestLogger => {
  const entries: LogEntry[] = [];
  const logger = makeLogger(
    (record: LogRecord) => {
      entries.push({
        scope: record.scope,
        level: record.level,
        message: record.message,
        data:
          record.context === undefined && record.error === undefined
            ? undefined
            : {
                ...record.context,
                ...(record.error ? { error: record.error } : {}),
              },
        runtime: record.runtime,
        pid: record.pid,
        error: record.error,
      });
    },
    {
      origin: { app: 'prismical', appVersion: 'test', appRunId: 'test-run' },
      source: { runtime: 'main', pid: 1 },
      filter: makeFilter({ isDev: true }),
    }
  );
  const service = logger.service;
  const transport = {
    ingest: logger.ingest,
    rendererConfig: { appVersion: 'test', appRunId: 'test-run', isDev: true },
    exportBundle: () => Effect.void,
  };
  return {
    entries,
    layer: Layer.merge(
      Layer.succeed(MainLogger, service),
      Layer.succeed(LoggingTransport, transport)
    ),
    find: predicate => entries.find(predicate),
  };
};
