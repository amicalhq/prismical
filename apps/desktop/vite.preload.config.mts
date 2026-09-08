import { defineConfig } from 'vite';
import { posthogSourceMapPlugins } from './vite.posthog';

// https://vitejs.dev/config
export default defineConfig({
  plugins: posthogSourceMapPlugins(),
  build: {
    sourcemap: process.env.POSTHOG_SOURCE_MAP_UPLOAD === 'true' ? 'hidden' : false,
    rollupOptions: {
      output: {
        // The plugin names outputs after the entry file — src/preload/main.ts
        // would land as .vite/build/main.js next to the main-process bundle.
        // Name it what it is.
        entryFileNames: 'preload.js',
      },
    },
  },
});
