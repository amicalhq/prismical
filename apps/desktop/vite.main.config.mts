// This config deliberately does NOT load
// apps/desktop/.env itself. Build inputs arrive as plain environment variables;
// forge.config.ts (the only supported build driver) loads .env for its own
// signing config first, so `pnpm dev` / `pnpm package` still pick a local .env
// up — but a bare `vite build` no longer silently absorbs one. See .env.example.
import { defineConfig } from 'vite';
import { posthogSourceMapPlugins } from './vite.posthog';

// The forge vite plugin supplies the load-bearing defaults for the `main`
// target: cjs lib build of the forge entry into .vite/build/, electron + node
// builtins external, and the MAIN_WINDOW_VITE_* define constants.
// https://vitejs.dev/config
export default defineConfig({
  plugins: posthogSourceMapPlugins(),
  build: {
    sourcemap: process.env.POSTHOG_SOURCE_MAP_UPLOAD === 'true' ? 'hidden' : false,
    rollupOptions: {
      // ONE entry only (the forge lib default: src/main/entry.ts →
      // .vite/build/entry.js). The whisper worker is deliberately NOT a
      // second input here: two rollup inputs hoist their shared module
      // (infra/whisper/protocol.ts) into a hash-named sibling chunk, and the
      // emitted whisper-worker-fork.js then starts with
      // `require('./protocol-<hash>.js')` — a file that stays INSIDE app.asar
      // when packaged, which the plain-Node sidecar cannot read. The worker
      // gets its own single-entry build instead (vite.worker.config.mts,
      // registered as a second `build` entry in forge.config.ts), so BOTH
      // bundles inline the protocol module and stay self-contained.
      //
      // better-sqlite3 is a native N-API binding (lib/binding.js requires the
      // prebuilds/<platform>-<arch>.node inside the package) — it cannot be
      // bundled. It stays a runtime require, shipped as real node_modules in
      // the package (EXTERNAL_DEPENDENCIES + prePackage copy in forge.config.ts).
      // The whisper wrapper likewise loads whisper.node at require time and is
      // shipped unpacked; the worker resolves it with a real node_modules walk.
      external: ['better-sqlite3', '@prismical/whisper-wrapper'],
    },
  },
  define: {
    __PRISMICAL_BUILD_ID__: JSON.stringify(
      process.env.POSTHOG_RELEASE_SHA ?? process.env.GITHUB_SHA ?? ''
    ),
    // Baked E2E gate: only PRISMICAL_E2E_PACKAGE=1 builds — the
    // same env that flips the inspector fuse in forge.config.ts — may honor
    // the PRISMICAL_E2E* env family when app.isPackaged. Production packages
    // bake `false` and scrub the env at entry (src/main/e2e-gate.ts).
    __PRISMICAL_E2E_BUILD__: JSON.stringify(process.env.PRISMICAL_E2E_PACKAGE === '1'),
    // The PUBLIC desktop OAuth client id — the FALLBACK for the runtime
    // `process.env.PRISMICAL_CLIENT_ID` read (config/live.ts). A distributed
    // build has no shell env, so release CI injects PRISMICAL_CLIENT_ID at
    // build time (release.yml). NO COMMITTED DEFAULT:
    // the production client id must be a build input, not source. Although a
    // PKCE public client id is not a credential (RFC 8252 §8.5), the OSS repo
    // must not pin every fork's sign-in to the production client row. Without
    // an injected value the app builds and runs; sign-in reports NOT_CONFIGURED.
    // Dev: put PRISMICAL_CLIENT_ID in apps/desktop/.env (see .env.example) —
    // forge loads it before this config runs.
    __PRISMICAL_CLIENT_ID__: JSON.stringify(process.env.PRISMICAL_CLIENT_ID ?? ''),
    // PostHog ingestion key. Same policy: build
    // input, no committed default — an empty value disables telemetry.
    __PRISMICAL_ANALYTICS_KEY__: JSON.stringify(process.env.PRISMICAL_ANALYTICS_KEY ?? ''),
    // Packaged-build endpoint defaults. Public hostnames (not credentials), so
    // they keep committed defaults — but as ONE overridable build seam instead
    // of literals scattered through src. config/live.ts consumes them for
    // PROD_ENDPOINTS.
    __PRISMICAL_CORE_API_URL__: JSON.stringify(
      process.env.PRISMICAL_CORE_API_URL_DEFAULT ?? 'https://core.prismical.ai'
    ),
    __PRISMICAL_NOTE_WS_URL__: JSON.stringify(
      process.env.PRISMICAL_NOTE_WS_URL_DEFAULT ?? 'wss://note.prismical.ai/collaboration'
    ),
    __PRISMICAL_WEB_APP_ORIGIN__: JSON.stringify(
      process.env.PRISMICAL_WEB_APP_ORIGIN_DEFAULT ?? 'https://app.prismical.ai'
    ),
    __PRISMICAL_ANALYTICS_HOST__: JSON.stringify(
      process.env.PRISMICAL_ANALYTICS_HOST_DEFAULT ?? 'https://p.prismical.ai'
    ),
  },
});
