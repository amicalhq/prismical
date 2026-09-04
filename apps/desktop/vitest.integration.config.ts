/**
 * The REAL local-whisper integration suite: forks the
 * built worker under the Node sidecar with a downloaded model. Deliberately
 * NOT part of `pnpm test` — run `pnpm test:local-asr` (which rebuilds the
 * worker bundle first). Prerequisites are asserted loudly by the tests.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules', '.vite', 'out', 'e2e'],
    // One worker process at a time on the GPU; a cold model load + ~13 s of
    // audio through base.en is seconds, not minutes.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
