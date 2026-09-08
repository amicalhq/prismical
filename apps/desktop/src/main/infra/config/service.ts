import { Context } from 'effect';

/**
 * The environment descriptor. `coreApiUrl` is main-only — the renderer never
 * receives it (the renderer cannot reach the server by
 * construction); env:get serves the renderer-safe subset.
 */
export interface EndpointDescriptor {
  readonly coreApiUrl: string;
  readonly noteWsUrl: string;
  readonly webAppOrigin: string;
  readonly analyticsKey: string | null;
  /** Analytics ingestion host; null when analytics is disabled. */
  readonly analyticsHost: string | null;
}

/**
 * Main-only OAuth config. Like `coreApiUrl`, none of this may enter
 * the renderer-safe EnvDescriptor — all auth traffic stays in the main
 * process. The endpoint URLs derive from `endpoints.coreApiUrl`, so the
 * PRISMICAL_CORE_API_URL override transparently retargets all of them (the
 * fake-OAuth-server injection seam for e2e).
 */
export interface AuthDescriptor {
  /** Public OAuth client id; '' when unset — sign-in fails with a tagged error, boot stays clean. */
  readonly oauthClientId: string;
  /** Derived from the build channel, never configured. */
  readonly redirectUri: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  readonly jwksUrl: string;
  /** Expected id_token `iss` at the auth base path: `${coreApiUrl}/api/auth`. */
  readonly issuer: string;
}

export interface AppConfigService {
  /** Public support SDK key and a fresh process-scoped script nonce. */
  readonly gleap: { readonly key: string; readonly cspNonce: string } | null;
  readonly isPackaged: boolean;
  /** PRISMICAL_E2E=1 — test kill-switch (no OS mutation, fake secure store, e2e IPC). */
  readonly isE2E: boolean;
  /**
   * Secret codec selected behind the E2E build-time gate. Local packaged smoke
   * builds may use the fake codec without suppressing real OAuth/browser flows.
   */
  readonly secureStoreMode: 'safeStorage' | 'e2e-fake';
  /**
   * PRISMICAL_E2E_FAKE_AI=1 under isE2E: AiProvider serves a
   * scripted no-network model so the packaged e2e can drive Ask and the
   * skill lanes in local mode. Never true outside E2E.
   */
  readonly e2eFakeAi: boolean;
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  readonly userDataDir: string;
  /** Absolute path of the operational DB file (':memory:' allowed in tests). */
  readonly operationalDbPath: string;
  /** Absolute path of the local-mode product DB file (':memory:' allowed in tests). */
  readonly localDbPath: string;
  /** Directory holding the per-(sub, org) cloud-cache product DB files. */
  readonly cloudCacheDir: string;
  /**
   * Directory holding downloaded local ASR model weights.
   * Device state shared by both modes; never inside the app bundle. Created
   * lazily on the first download — never at boot.
   */
  readonly modelsDir: string;
  /**
   * Directory holding the per-recording recovery WAVs (`<recoveryDir>/<recordingId>/`).
   * Always under the real profile (dev included) — the recovery drain and the
   * destructive reset both resolve it from here.
   */
  readonly recoveryDir: string;
  /** Vite dev-server URL when running under `forge start`, else null. */
  readonly rendererDevServerUrl: string | null;
  readonly endpoints: EndpointDescriptor;
  readonly auth: AuthDescriptor;
  /** Updater hard gate: app.isPackaged && !PRISMICAL_E2E. */
  readonly updaterEnabled: boolean;
}

export class AppConfig extends Context.Tag('desktop/AppConfig')<AppConfig, AppConfigService>() {}
