import { defineConfig } from 'vite';

// Notify-window preload build. A third preload target — the
// plugin names outputs after the entry file, so name it notify-preload.js
// (windows/live.ts loads it by that basename).
// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'notify-preload.js',
      },
    },
  },
});
