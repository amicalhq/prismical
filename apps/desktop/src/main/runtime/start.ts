/**
 * The only module that touches raw Electron lifecycle before the runtime
 * exists. Effects run only at adapter boundaries; this is the
 * process boundary. Everything else lives in the Effect service graph.
 *
 * Order matters:
 *   1. PRISMICAL_E2E_BREAK_BOOT — throw at module evaluation so entry.ts's
 *      fatal boundary is the only observer (e2e/broken-boot.spec.ts).
 *   2. requestSingleInstanceLock — quit AND return when lost; nothing below
 *      may run after the quit request.
 *   3. Privileged custom scheme registration — must precede app ready.
 *   4. prismical:// OS protocol registration (skipped under E2E: no OS-state
 *      mutation from tests).
 *   5. Build the ManagedRuntime, run the Boot program, and wire the single
 *      quit path: program resolves (quit signal) → disposeAndExit (the ONLY
 *      runtime.dispose caller) → app.exit(0). Any rejection → exit(1); boot
 *      failures never soft-continue.
 */
import path from 'node:path';
import { WINDOWS_APP_USER_MODEL_ID } from '../app-identity';
import { app, protocol } from 'electron';
import { Cause, Effect, Runtime } from 'effect';
import { disposeAndExit } from '../domains/shutdown/shutdown';
import { APP_SCHEME } from '../domains/windows/policy';
import { bootProgram } from './boot-program';
import { makeDesktopRuntime } from './runtime';
import type { makeMainLogging } from '../infra/logging/live';

if (process.env.PRISMICAL_E2E_BREAK_BOOT === '1') {
  // e2e/broken-boot.spec.ts: a deliberately broken boot must FAIL the launch.
  throw new Error('Deliberately broken boot (PRISMICAL_E2E_BREAK_BOOT=1)');
}

export function startDesktop(logging: ReturnType<typeof makeMainLogging>): void {
  const log = logging.service.scopedSync('main');
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    // Another instance owns this profile. Nothing below may run.
    app.quit();
  } else {
    if (process.platform === 'win32') {
      // Match the custom identity written by our Squirrel install/update hooks.
      app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
    }

    // The renderer's rooted scheme is standard+secure so root-absolute
    // asset paths and fetch() work; served by WindowRegistry's protocol.handle.
    protocol.registerSchemesAsPrivileged([
      {
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
      },
    ]);

    if (process.env.PRISMICAL_E2E !== '1') {
      // Protocol registration mutates OS state (LaunchServices / registry);
      // tests never touch machine state.
      registerProtocolHandlers();
    }

    const runtime = makeDesktopRuntime(logging);
    runtime
      .runPromise(Effect.scoped(bootProgram))
      .then(() =>
        // Quit path: program scope is closed; dispose the runtime (layer
        // finalizers: DB close, listener removal, tray detach) with a bounded
        // deadline, then exit. disposeAndExit always exits 0.
        Effect.runPromise(
          disposeAndExit({
            dispose: () => runtime.dispose(),
            exit: code => {
              app.exit(code);
            },
            onFailure: error =>
              log.error('Runtime shutdown failed', { error: failureCause(error) }),
            onTimeout: () => {
              log.error('Runtime shutdown exceeded deadline; exiting');
            },
          })
        )
      )
      .catch((error: unknown) => {
        // Boot/program failure. No dispose here — the quit path is the only
        // dispose caller; a non-zero exit tears the process down regardless.
        log.error('Application boot failed', {
          error: failureCause(error),
        });
        app.exit(1);
      });
  }
}

function failureCause(error: unknown): unknown {
  return Runtime.isFiberFailure(error) ? Cause.squash(error[Runtime.FiberFailureCauseId]) : error;
}

function registerProtocolHandlers(): void {
  // prismical:// always because the closed app owns the scheme; prismical-dev://
  // additionally in unpackaged builds so dev OAuth callbacks land here
  // without fighting an installed packaged app.
  const schemes = app.isPackaged ? ['prismical'] : ['prismical', 'prismical-dev'];
  for (const scheme of schemes) {
    if (process.defaultApp) {
      // Running via the Electron binary (dev/bundle): registration needs the
      // explicit exec-path + app-path argv form.
      if (process.argv.length >= 2 && process.argv[1]) {
        app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
      }
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }
}
