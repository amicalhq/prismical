import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
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
