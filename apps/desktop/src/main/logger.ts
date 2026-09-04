/**
 * Thin scoped-logger seam for the native modules.
 *
 * This logger integration is deliberately minimal: it only
 * provides the `logger.<scope>` / `createScopedLogger` surface the native
 * infra modules call. It must stay importable outside Electron (vitest runs
 * the golden-fixture tests in plain node, where electron-log resolves its
 * node transport).
 */
import path from "node:path";
import log from "electron-log";

log.scope.labelPadding = false;

// E2E log hermeticity: electron-log's default
// resolvePathFn uses `libraryDefaultDir`, which on macOS is the SHARED
// ~/Library/Logs/<appName> regardless of app.setPath('userData') — so
// isolated e2e profiles would interleave their logs (and the sentinel-token
// scans would read other runs' output). Under the e2e harness, pin the file
// transport into the per-run profile dir instead. Env-driven on purpose:
// this module must stay importable outside Electron — which also means it
// cannot see app.isPackaged, so the packaged-production gate for this seam
// lives upstream: entry.ts scrubs the PRISMICAL_E2E* family from process.env
// (src/main/e2e-gate.ts) before this module evaluates in untrusted binaries.
const e2eUserDataDir =
  process.env.PRISMICAL_E2E === "1" ? process.env.PRISMICAL_E2E_USER_DATA_DIR : undefined;
if (e2eUserDataDir) {
  const logDir = path.join(e2eUserDataDir, "logs");
  log.transports.file.resolvePathFn = variables =>
    path.join(logDir, variables.fileName ?? "main.log");
}

export function createScopedLogger(scope: string) {
  return log.scope(scope);
}

// Scopes used by the native modules today.
export const logger = {
  main: createScopedLogger("main"),
  audio: createScopedLogger("audio"),
  transcription: createScopedLogger("transcription"),
};

export { log };
