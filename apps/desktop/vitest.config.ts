import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // tests/integration needs the Node sidecar + a downloaded model + the built
    // worker bundle — `pnpm test:local-asr` (vitest.integration.config.ts).
    exclude: ['node_modules', '.vite', 'out', 'e2e', 'tests/integration/**'],
    // Explicit pool config: isolated parallel forks.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
