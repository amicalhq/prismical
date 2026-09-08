import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';
import { Effect, Layer } from 'effect';
import {
  bakedE2EBuild,
  isE2EActive,
  shouldUseE2EFakeSecureStore,
} from '../../e2e-gate';
import {
  AppConfig,
  type AppConfigService,
  type AuthDescriptor,
  type EndpointDescriptor,
} from './service';
import { mainWindowDevServerUrl } from '../electron/vite-constants';

// Portless development defaults and packaged production defaults.
const DEV_ENDPOINTS: EndpointDescriptor = {
  coreApiUrl: 'https://prismical-core.localhost',
  noteWsUrl: 'wss://prismical-note.localhost/collaboration',
  webAppOrigin: 'https://prismical-web.localhost',
  analyticsKey: null,
  // Ingestion host used only when a key is present. Development stays silent
  // unless PRISMICAL_ANALYTICS_KEY is set.
  analyticsHost: 'https://p.prismical.ai',
};

// Build-time baked values (vite.main.config.mts defines). The typeof guards
// cover vitest/tsc, where the globals are UNDECLARED — only vite substitutes
// them. Empty string = "not injected".
const baked = (value: string | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

// Packaged production defaults — every value is a build input. The public
// endpoint hostnames keep committed defaults in the Vite config. The analytics
// key has no committed default: release CI injects PRISMICAL_ANALYTICS_KEY, and
// a build without it ships with telemetry disabled.
const PROD_ENDPOINTS: EndpointDescriptor = {
  coreApiUrl:
    baked(typeof __PRISMICAL_CORE_API_URL__ === 'undefined' ? undefined : __PRISMICAL_CORE_API_URL__) ??
    'https://core.prismical.ai',
  noteWsUrl:
    baked(typeof __PRISMICAL_NOTE_WS_URL__ === 'undefined' ? undefined : __PRISMICAL_NOTE_WS_URL__) ??
    'wss://note.prismical.ai/collaboration',
  webAppOrigin:
    baked(
      typeof __PRISMICAL_WEB_APP_ORIGIN__ === 'undefined' ? undefined : __PRISMICAL_WEB_APP_ORIGIN__
    ) ?? 'https://app.prismical.ai',
  analyticsKey: baked(
    typeof __PRISMICAL_ANALYTICS_KEY__ === 'undefined' ? undefined : __PRISMICAL_ANALYTICS_KEY__
  ),
  analyticsHost:
    baked(
      typeof __PRISMICAL_ANALYTICS_HOST__ === 'undefined' ? undefined : __PRISMICAL_ANALYTICS_HOST__
    ) ?? 'https://p.prismical.ai',
};

const readEndpoints = (isPackaged: boolean): EndpointDescriptor => {
  const defaults = isPackaged ? PROD_ENDPOINTS : DEV_ENDPOINTS;
  return {
    coreApiUrl: process.env.PRISMICAL_CORE_API_URL ?? defaults.coreApiUrl,
    noteWsUrl: process.env.PRISMICAL_NOTE_WS_URL ?? defaults.noteWsUrl,
    webAppOrigin: process.env.PRISMICAL_WEB_APP_ORIGIN ?? defaults.webAppOrigin,
    analyticsKey: process.env.PRISMICAL_ANALYTICS_KEY ?? defaults.analyticsKey,
    analyticsHost: process.env.PRISMICAL_ANALYTICS_HOST ?? defaults.analyticsHost,
  };
};

const readAuth = (isPackaged: boolean, endpoints: EndpointDescriptor): AuthDescriptor => {
  const core = endpoints.coreApiUrl;
  return {
    // The vite-baked public OAuth client id has no committed default: release
    // CI injects it, and dev supplies it via apps/desktop/.env (see .env.example).
    // Without either, boot stays clean and sign-in fails with the tagged
    // NOT_CONFIGURED error. The typeof guard covers vitest/tsc, where
    // the global is UNDECLARED (a bare read would ReferenceError).
    oauthClientId:
      process.env.PRISMICAL_CLIENT_ID ??
      (typeof __PRISMICAL_CLIENT_ID__ === 'undefined' ? '' : __PRISMICAL_CLIENT_ID__),
    // Packaged builds keep the prismical:// scheme (a real .app bundle owns
    // its id, so LaunchServices routes it correctly). Dev CANNOT use a custom
    // scheme at all: every electron dev checkout shares com.github.Electron,
    // so the OS may launch a bare Electron from another repo's node_modules
    // instead of this running app (and an installed Prismical.app contends for
    // prismical:// too). Dev therefore uses the local receiver in
    // deep-link/dev-loopback.ts through portless; the public callback URL
    // stays fixed while portless allocates the listener's internal port.
    redirectUri: isPackaged
      ? 'prismical://oauth/callback'
      : 'https://prismical-desktop.localhost/oauth/callback',
    // All derived from coreApiUrl — PRISMICAL_CORE_API_URL retargets the lot
    // (single knob; e2e points it at the fake OAuth server).
    authorizeUrl: `${core}/api/auth/oauth2/authorize`,
    tokenUrl: `${core}/api/auth/oauth2/token`,
    revokeUrl: `${core}/api/auth/oauth2/revoke`,
    // Expected ID token issuer, checked after exchange and refresh.
    issuer: `${core}/api/auth`,
  };
};

export const makeAppConfig = (): AppConfigService => {
  const isPackaged = app.isPackaged;
  const baked = bakedE2EBuild();
  // entry.ts already scrubs PRISMICAL_E2E* from untrusted binaries;
  // the pure gate is applied here TOO (belt and braces) — isE2E fans out to
  // the SecureStore codec, the e2e IPC channels, and the preload argv switch,
  // so a production package must never derive it from env alone.
  const isE2E = isE2EActive({
    envFlag: process.env.PRISMICAL_E2E === '1',
    isPackaged,
    baked,
  });
  const secureStoreMode = shouldUseE2EFakeSecureStore({
    isE2E,
    envFlag: process.env.PRISMICAL_E2E_FAKE_SECURE_STORE === '1',
    baked,
  })
    ? 'e2e-fake'
    : 'safeStorage';
  // The scripted AI model is an isE2E-only seam (no separate baked arm —
  // it exists purely for the e2e lanes, never for smoke builds).
  const e2eFakeAi = isE2E && process.env.PRISMICAL_E2E_FAKE_AI === '1';
  const userDataDir = app.getPath('userData');
  // Packaged/E2E: live in the (possibly test-isolated) profile. Dev: a
  // gitignored .data/ under apps/desktop so `forge start` never touches the
  // real profile.
  const operationalDbPath =
    isPackaged || isE2E
      ? path.join(userDataDir, 'operational.db')
      : path.join(app.getAppPath(), '.data', 'operational.db');
  // Product stores: local-mode local.db + the per-(sub, org) cloud-cache
  // directory — same split as operationalDbPath.
  const localDbPath =
    isPackaged || isE2E
      ? path.join(userDataDir, 'local.db')
      : path.join(app.getAppPath(), '.data', 'local.db');
  const cloudCacheDir =
    isPackaged || isE2E
      ? path.join(userDataDir, 'cloud-cache')
      : path.join(app.getAppPath(), '.data', 'cloud-cache');
  // Downloaded local ASR weights use the same split; multi-GB files live in the
  // profile, never in the signed bundle's resources.
  const modelsDir =
    isPackaged || isE2E
      ? path.join(userDataDir, 'models')
      : path.join(app.getAppPath(), '.data', 'models');

  // Recovery WAVs stay under the real profile in every build; the destructive
  // reset purges this tree, so the path is resolved ONCE here.
  const recoveryDir = path.join(userDataDir, 'recovery');

  const endpoints = readEndpoints(isPackaged);
  const gleapKey = (process.env.GLEAP_KEY ?? (
    isPackaged && typeof __GLEAP_KEY__ !== 'undefined' ? __GLEAP_KEY__ : ''
  )).trim();

  return {
    gleap: gleapKey ? { key: gleapKey, cspNonce: randomBytes(24).toString('base64') } : null,
    isPackaged,
    isE2E,
    secureStoreMode,
    e2eFakeAi,
    platform: process.platform,
    appVersion: app.getVersion(),
    userDataDir,
    operationalDbPath,
    localDbPath,
    cloudCacheDir,
    modelsDir,
    recoveryDir,
    rendererDevServerUrl: mainWindowDevServerUrl(),
    endpoints,
    auth: readAuth(isPackaged, endpoints),
    updaterEnabled: isPackaged && !isE2E,
  };
};

export const AppConfigLive: Layer.Layer<AppConfig> = Layer.effect(
  AppConfig,
  Effect.sync(makeAppConfig)
);
