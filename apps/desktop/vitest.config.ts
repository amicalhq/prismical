import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    // Default to node; tests that need a DOM (TipTap Editor instantiation,
    // ProseMirror view, etc.) opt in via `// @vitest-environment happy-dom`
    // at the top of the file.
    environment: "node",
    include: ["tests/**/*.{test,spec}.{js,ts,jsx,tsx}"],
    exclude: ["node_modules", ".vite", "out"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30000, // 30 seconds for full app initialization
    hookTimeout: 30000,
    // Run tests sequentially to avoid database conflicts
    threads: false,
    // Isolate environment for each test file
    isolate: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@db": resolve(__dirname, "src/db"),
      "@main": resolve(__dirname, "src/main"),
      "@services": resolve(__dirname, "src/services"),
      "@utils": resolve(__dirname, "src/utils"),
      "@trpc": resolve(__dirname, "src/trpc"),
    },
  },
});
