import { defineConfig } from 'vite';

// Widget-window preload build. A second preload target
// alongside the main-window one — the plugin names outputs after the entry file,
// so name it widget-preload.js (windows/live.ts loads it by that basename).
// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'widget-preload.js',
      },
    },
  },
});
