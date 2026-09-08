/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

/**
 * Baked at build time by vite.main.config.mts (define): true only for
 * PRISMICAL_E2E_PACKAGE=1 builds. Undefined under vitest/tsc — read it via
 * src/main/e2e-gate.ts's bakedE2EBuild(), never directly.
 */
declare const __PRISMICAL_E2E_BUILD__: boolean | undefined;

/**
 * The PUBLIC desktop OAuth client id, baked at build time by vite.main.config.mts
 * (define) from apps/desktop/.env — the FALLBACK for `process.env.PRISMICAL_CLIENT_ID`
 * so a distributed build (no runtime env) still signs in. Undefined under
 * vitest/tsc. Read it only via the `process.env.PRISMICAL_CLIENT_ID ?? … ?? ''`
 * chain in config/live.ts, never directly.
 */
declare const __PRISMICAL_CLIENT_ID__: string | undefined;

/**
 * PostHog ingestion key baked at build time (vite.main.config.mts define) from
 * PRISMICAL_ANALYTICS_KEY. Empty/undefined ⇒ telemetry disabled. Read via
 * config/live.ts only.
 */
declare const __PRISMICAL_ANALYTICS_KEY__: string | undefined;
/** Public Gleap client SDK key; empty/undefined disables support chat. */
declare const __GLEAP_KEY__: string | undefined;

/**
 * Packaged-build endpoint defaults, baked at build time (vite.main.config.mts
 * defines). Public hostnames with committed defaults; overridable per build via
 * PRISMICAL_*_DEFAULT env. Read via config/live.ts only.
 */
declare const __PRISMICAL_CORE_API_URL__: string | undefined;
declare const __PRISMICAL_NOTE_WS_URL__: string | undefined;
declare const __PRISMICAL_WEB_APP_ORIGIN__: string | undefined;
declare const __PRISMICAL_ANALYTICS_HOST__: string | undefined;

/** Public build revision for diagnostics; source-map credentials are never baked. */
declare const __PRISMICAL_BUILD_ID__: string | undefined;
