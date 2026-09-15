import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { posthogSourceMapPlugins } from './vite.posthog';

// A self-contained bundle can run outside app.asar without loading editor code in main.
export default defineConfig({
  plugins: posthogSourceMapPlugins(),
  build: {
    sourcemap: process.env.POSTHOG_SOURCE_MAP_UPLOAD === 'true' ? 'hidden' : false,
    outDir: '.vite/build',
    emptyOutDir: false,
    copyPublicDir: false,
    minify: true,
    lib: {
      entry: resolve(__dirname, 'src/main/domains/local-backend/skill-recovery-worker.ts'),
      formats: ['cjs'],
      fileName: () => 'skill-recovery-worker.js',
    },
    rollupOptions: {
      external: builtinModules.flatMap(name => [name, `node:${name}`]),
    },
  },
  resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] },
});
