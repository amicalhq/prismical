/**
 * The whisper worker bundle — a SEPARATE single-entry
 * vite build of src/main/infra/whisper/whisper-worker-fork.ts into
 * .vite/build/whisper-worker-fork.js.
 *
 * Separate on purpose: as a second rollup input of
 * the MAIN build, rollup hoists the module both entries share
 * (infra/whisper/protocol.ts) into a hash-named chunk, and the emitted worker
 * starts with `require('./protocol-<hash>.js')`. The forge asar.unpack glob
 * unpacks only whisper-worker-fork.js, so that chunk stays INSIDE app.asar —
 * which the bundled plain-Node SIDECAR (the worker's runtime; it is NOT
 * electron and cannot read asar) can never load. A single-entry build has
 * nothing to share, so the protocol module inlines and the emitted worker is
 * fully self-contained.
 *
 * ONE config, two drivers, so dev/eval and packaged semantics cannot drift:
 *  - electron-forge (start/package/make): the second `build` entry in
 *    forge.config.ts (target 'main' — the plugin merges its node/cjs base in;
 *    everything load-bearing is restated here so that merge is a no-op);
 *  - `pnpm build:worker` (scripts/build-whisper-worker.ts): a plain
 *    `vite build` over this same file, for test:local-asr + eval harnesses.
 *
 * Self-sufficient on purpose: CommonJS lib output (the app is not
 * "type":"module", so a bare ESM `.js` could not be require()d), Node
 * builtins + electron external, `node` resolve conditions, `.vite/build`
 * outDir with emptyOutDir OFF (never clobber entry.js beside it). The
 * whisper wrapper loads whisper.node at require time and is shipped unpacked;
 * it stays a runtime require the worker resolves with a real node_modules walk.
 */
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const builtins = [
  'electron',
  'electron/common',
  'electron/main',
  ...builtinModules.flatMap(m => [m, `node:${m}`]),
];

export default defineConfig({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    copyPublicDir: false,
    minify: true,
    lib: {
      entry: resolve(__dirname, 'src/main/infra/whisper/whisper-worker-fork.ts'),
      formats: ['cjs'],
      fileName: () => 'whisper-worker-fork.js',
    },
    rollupOptions: {
      external: ['better-sqlite3', '@prismical/whisper-wrapper', ...builtins],
    },
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
