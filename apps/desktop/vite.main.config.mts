import { defineConfig } from "vite";
import { resolve } from "path";

// https://vitejs.dev/config
export default defineConfig({
  define: {
    __BUNDLED_POSTHOG_API_KEY: JSON.stringify(
      process.env.POSTHOG_API_KEY || "",
    ),
    __BUNDLED_POSTHOG_HOST: JSON.stringify(process.env.POSTHOG_HOST || ""),
    __BUNDLED_TELEMETRY_ENABLED: JSON.stringify(
      process.env.TELEMETRY_ENABLED !== "false",
    ),
    __BUNDLED_AUTH_CLIENT_ID: JSON.stringify(process.env.AUTH_CLIENT_ID || ""),
    __BUNDLED_AUTH_AUTHORIZATION_ENDPOINT: JSON.stringify(
      process.env.AUTHORIZATION_ENDPOINT || "",
    ),
    __BUNDLED_AUTH_TOKEN_ENDPOINT: JSON.stringify(
      process.env.AUTH_TOKEN_ENDPOINT || "",
    ),
    __BUNDLED_API_ENDPOINT: JSON.stringify(process.env.API_ENDPOINT || ""),
    __BUNDLED_FEEDBACK_SURVEY_ID: JSON.stringify(
      process.env.FEEDBACK_SURVEY_ID || "",
    ),
    __BUNDLED_AUTH_REDIRECT_URI: JSON.stringify(
      process.env.AUTH_REDIRECT_URI || "",
    ),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/main/main.ts"),
        "whisper-worker-fork": resolve(
          __dirname,
          "src/pipeline/providers/transcription/whisper-worker-fork.ts",
        ),
      },
      output: {
        entryFileNames: "[name].js",
      },
      external: [
        "@prismical/whisper-wrapper",
        "@libsql/client",
        "@libsql/darwin-arm64",
        "@libsql/darwin-x64",
        "@libsql/linux-x64-gnu",
        "@libsql/linux-x64-musl",
        "@libsql/win32-x64-msvc",
        "libsql",
        "onnxruntime-node",
        /^node:/,
        /^electron$/,
      ],
    },
  },
  resolve: {
    // Forge's base main config sets `conditions: ['node']`, which makes the
    // resolver pick the "node" export of every `@lexical/*` package — each of
    // those is a `.node.mjs` that uses top-level await and breaks Rollup's CJS
    // output. Adding "development"/"production" here (merged with forge's list)
    // lets the resolver match the "development"/"production" keys in the
    // package.json exports object FIRST, picking the plain ESM variants which
    // have no TLA.
    conditions: ["development", "production"],
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  optimizeDeps: {
    exclude: [
      "better-sqlite3",
      "@prismical/whisper-wrapper",
      "drizzle-orm",
      "@libsql/client",
    ],
  },
});
