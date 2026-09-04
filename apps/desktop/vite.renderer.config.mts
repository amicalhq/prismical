import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// posthog-js's default entry lazy-loads the rrweb session-replay recorder + the
// exception-autocapture module as remote <script>s, which the packaged renderer
// CSP (`script-src 'self'`) blocks — replay would silently never start. Bundle
// the INLINE (no-external) build instead so the recorder ships in the app bundle:
// script-src stays locked AND there's no dependency on the reverse proxy
// forwarding /static/. Aliased to an absolute path so source keeps the standard
// `posthog-js` import + types (analytics/posthog.ts).
const posthogNoExternal = path.join(
  path.dirname(createRequire(import.meta.url).resolve('posthog-js/package.json')),
  'dist',
  'module.full.no-external.js'
);

// Main-window renderer build. The @electron-forge/plugin-vite
// plugin supplies root/base/outDir and exposes the dev-server URL to the main
// build; this config adds the React + Tailwind v4 pipeline the shared
// @prismical/app-ui shell needs. Assets under public/ (prismical-icon, provider
// logos, the audio worklet) copy to the renderer root and are served over the
// privileged prismical-app:// scheme (windows/policy.ts#resolveRendererAssetPath).
// https://vitejs.dev/config
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // Multi-page renderer: one renderer build emits the
  // main-window shell (index.html), the floating widget (widget.html), and the
  // notification layer (notify.html) into the same `main_window` bundle dir —
  // protocol.handle + the CSP membrane + the dev server serve every page over
  // the same privileged `bundle` host unchanged.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        widget: path.resolve(__dirname, 'widget.html'),
        notify: path.resolve(__dirname, 'notify.html'),
      },
    },
  },
  resolve: {
    // The forge renderer base pins preserveSymlinks:true (main/preload need it);
    // for the browser renderer bundle that breaks pnpm's nested transitive
    // resolution (Rollup can't find @tanstack/react-router's @tanstack/router-core
    // et al. through the symlink path). Resolve to real paths, as a normal Vite
    // app does. mergeConfig lets this override the base.
    preserveSymlinks: false,
    // Exact-match only (`$`), so subpaths of posthog-js don't re-alias.
    alias: [{ find: /^posthog-js$/, replacement: posthogNoExternal }],
  },
  define: {
    // The sandboxed renderer main-world has no `process` global; the shared data
    // layer reads only these two keys (api/auth.ts dev-token fallback, the
    // ai-models dev tiles). Replace them statically so no `process` survives.
    'process.env.NODE_ENV': JSON.stringify(
      mode === 'production' ? 'production' : 'development'
    ),
    'process.env.NEXT_PUBLIC_DEV_ID_TOKEN': 'undefined',
  },
}));
