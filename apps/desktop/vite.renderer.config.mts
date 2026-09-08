import path from 'node:path';
import { defineConfig } from 'vite';
import { posthogSourceMapPlugins } from './vite.posthog';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Main-window renderer build. The @electron-forge/plugin-vite
// plugin supplies root/base/outDir and exposes the dev-server URL to the main
// build; this config adds the React + Tailwind v4 pipeline the shared
// @prismical/app-ui shell needs. Assets under public/ (prismical-icon, provider
// logos, the audio worklet) copy to the renderer root and are served over the
// privileged prismical-app:// scheme (windows/policy.ts#resolveRendererAssetPath).
// https://vitejs.dev/config
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...posthogSourceMapPlugins()],
  // Multi-page renderer: one renderer build emits the
  // main-window shell (index.html), the floating widget (widget.html), and the
  // notification layer (notify.html) into the same `main_window` bundle dir —
  // protocol.handle + the CSP membrane + the dev server serve every page over
  // the same privileged `bundle` host unchanged.
  build: {
    sourcemap: process.env.POSTHOG_SOURCE_MAP_UPLOAD === 'true' ? 'hidden' : false,
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
  },
  define: {
    // The sandboxed renderer main-world has no `process` global; the shared data
    // layer reads only these two keys (api/auth.ts dev-token fallback, the
    // ai-models dev tiles). Replace them statically so no `process` survives.
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    'process.env.NEXT_PUBLIC_DEV_ID_TOKEN': 'undefined',
  },
}));
