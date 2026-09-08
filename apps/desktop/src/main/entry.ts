import { app, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import type { MainLoggerService } from '@desktop/logging';
import { handleSquirrelStartup } from './squirrel-startup';
import { configureSystemTrustStore } from './system-trust-store';
import { bakedE2EBuild, e2eEnvTrusted, scrubE2EEnv } from './e2e-gate';

// Packaged-E2E gating: a production packaged binary must ignore
// the PRISMICAL_E2E* env family — honoring it would downgrade refresh-token
// custody to the plaintext-equivalent e2e codec, open the e2e IPC surface,
// and redirect logs/userData. Only e2e-baked packages (PRISMICAL_E2E_PACKAGE=1
// bakes __PRISMICAL_E2E_BUILD__=true) and unpackaged runs keep it. Scrubbing
// here — before the setPath below, before logging/config/start.ts evaluate —
// makes every downstream consumer read sanitized env by construction.
if (!e2eEnvTrusted({ isPackaged: app.isPackaged, baked: bakedE2EBuild() })) {
  scrubE2EEnv(process.env);
}

// E2E harness hook (see e2e/): give each test run an isolated profile. Must be
// applied before anything touches the single-instance lock — runtime/start.ts
// keys requestSingleInstanceLock() off userData, and an isolated path keeps
// test instances from colliding with a real running Prismical. sessionData is
// set too so Chromium caches follow.
if (process.env.PRISMICAL_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.PRISMICAL_E2E_USER_DATA_DIR);
  app.setPath('sessionData', process.env.PRISMICAL_E2E_USER_DATA_DIR);
}

if (handleSquirrelStartup()) {
  // Squirrel.Windows event hook process (--squirrel-install/-updated/
  // -obsolete/-uninstall): the handler runs Update.exe, applies our shortcut
  // identity, then quits. Nothing else may run here —
  // loading the app would reach requestSingleInstanceLock(), which fires
  // second-instance in the already-running app mid-background-update.
} else {
  // The entire app lives behind this dynamic import so a module-evaluation
  // failure anywhere in its graph rejects here — the fatal boundary — instead
  // of crashing the process before any error handling exists. Keep this
  // entry's own imports minimal for the same reason. The boot failure is
  // always fatal (exit 1): e2e/broken-boot.spec.ts asserts that a broken boot
  // fails the launch, so nothing between here and the harness may swallow it.
  const appRunId = randomUUID();
  let logger: MainLoggerService | undefined;
  import('./infra/logging/live')
    .then(({ makeMainLogging }) => {
      const logging = makeMainLogging(appRunId);
      logger = logging.service;
      logger.scopedSync('startup').info('Application logging initialized');
      try {
        configureSystemTrustStore();
      } catch (error) {
        logger.scopedSync('startup').warn('Failed to load system CA certificates', { error });
      }
      return import('./runtime/start').then(({ startDesktop }) => startDesktop(logging));
    })
    .catch(async (error: unknown) => {
      if (logger) logger.scopedSync('startup').error('Failed to load application', { error });
      else {
        // Logging itself may be the broken module. Never expose the raw error in
        // this last-resort path, and never recurse through the failing transport.
        process.stderr.write(
          `${JSON.stringify({
            schemaVersion: 1,
            timestamp: new Date().toISOString(),
            app: 'prismical',
            appVersion: app.getVersion(),
            appRunId,
            runtime: 'main',
            pid: process.pid,
            scope: 'startup',
            level: 'error',
            message: 'Failed to initialize application logging',
          })}\n`
        );
      }
      if (process.env.PRISMICAL_E2E !== '1') {
        // showErrorBox is safe before the ready event; skipped under E2E because
        // the modal would hang a headless run — the non-zero exit still lands.
        let title = 'Prismical failed to start';
        let message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        try {
          const copy = (await import('./fatal-i18n')).fatalDialogCopy();
          title = copy.title;
          message = `${copy.description}\n\n${copy.detailsLabel}:\n${message}`;
        } catch {
          // This is the last-resort boundary; even i18n may be the failed module.
        }
        dialog.showErrorBox(title, message);
      }
      app.exit(1);
    });
}
