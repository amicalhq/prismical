/**
 * Build ONLY the whisper worker bundle (.vite/build/whisper-worker-fork.js)
 * without a full forge run. `electron-forge start` /
 * `package` / `make` build the SAME config as their own second `build` entry
 * (forge.config.ts); the integration suite (`pnpm test:local-asr`) and the
 * eval harnesses need the bundle fresh WITHOUT launching electron or
 * packaging.
 *
 * One config, two drivers: vite.worker.config.mts carries EVERYTHING that
 * makes the output loadable by the Node sidecar (single self-contained entry
 * — no shared chunk, CommonJS lib output, Node builtins + electron external,
 * `node` resolve conditions, `.vite/build` outDir with emptyOutDir off). This
 * script just runs a plain `vite build` over that config, so the dev/eval
 * bundle and the packaged one cannot drift.
 *
 * usage  pnpm build:worker
 */
import path from 'node:path';
import { build, mergeConfig, type UserConfig } from 'vite';
import workerConfig from '../vite.worker.config.mts';

const root = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  await build(
    mergeConfig(workerConfig as UserConfig, {
      configFile: false,
      root,
      mode: 'production',
      clearScreen: false,
      logLevel: 'warn',
    })
  );
  console.log('[build-whisper-worker] wrote .vite/build/whisper-worker-fork.js');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
