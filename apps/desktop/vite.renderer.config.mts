import { defineConfig } from "vite";
import { resolve } from "path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
// https://vitejs.dev/config
export default defineConfig(async () => {
  const { default: tailwindcss } = await import("@tailwindcss/vite");

  return {
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: "./src/renderer/main/routes",
        generatedRouteTree: "./src/renderer/main/routeTree.gen.ts",
      }),
      tailwindcss(),
    ],
    publicDir: "public",
    // PRSM-28: don't watch locale JSON. JSON imports can't HMR, so each edit
    // becomes a `[vite] (client) page reload` broadcast on the HMR websocket;
    // if a Chrome tab is connected (e.g. via chrome-devtools-mcp), the reload
    // reactivates Chrome and steals focus. Trade-off: locale edits won't
    // refresh the renderer until `pnpm dev` is restarted manually.
    server: {
      watch: {
        ignored: ["**/src/i18n/locales/*.json"],
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    optimizeDeps: {
      //! facing issues with main window at times
      //! and excluding next-themes and sonner isn't helping either
      //! 504 outdated optimize deps
      //! likely due to configs changing upon route tree regen of tanstack router
      force: true,
      exclude: ["better-sqlite3"],
    },
  };
});
