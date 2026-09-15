import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { setupFiles: ['../app-client/vitest.jsdom-storage.setup.ts'] },
});
