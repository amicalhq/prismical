import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Preview-only adapters. Production renderer builds never load these aliases.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@prismical\/app-client$/,
        replacement: path.resolve(__dirname, 'preview/onboarding/services.ts'),
      },
    ],
  },
  server: { host: '127.0.0.1', allowedHosts: ['.localhost'] },
  build: {
    outDir: '.vite/onboarding-preview',
    rollupOptions: { input: path.resolve(__dirname, 'onboarding-preview.html') },
  },
});
