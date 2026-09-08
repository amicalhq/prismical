import { defineConfig } from 'vite';
import { posthogSourceMapPlugins } from './vite.posthog';

// Notify-window preload build. A third preload target — the
// plugin names outputs after the entry file, so name it notify-preload.js
// (windows/live.ts loads it by that basename).
// https://vitejs.dev/config
export default defineConfig({
  plugins: posthogSourceMapPlugins(),
  build: {
    sourcemap: process.env.POSTHOG_SOURCE_MAP_UPLOAD === 'true' ? 'hidden' : false,
    rollupOptions: {
      output: {
        entryFileNames: 'notify-preload.js',
      },
    },
  },
});
