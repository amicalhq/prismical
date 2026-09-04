import { defineConfig } from "vitest/config";

// Mirrors the web app's vitest setup: node environment by
// default; the DOM-dependent suites (query-client, collab, hooks) opt into
// jsdom per-file via a `// @vitest-environment jsdom` pragma. No `@/` alias —
// shared code uses relative and package-root imports only.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // Restores localStorage/sessionStorage for the jsdom-pragma files — see the setup file.
    setupFiles: ["./vitest.jsdom-storage.setup.ts"],
  },
});
