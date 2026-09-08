import type { Details, RenderProcessGoneDetails } from 'electron';
import { Effect, Option, Queue, SubscriptionRef } from 'effect';
import { projectTelemetryException } from '../../../shared/telemetry-exception';
import { MainLogger } from '../../infra/logging/service';
import { WindowRegistry } from '../windows/service';
import { TelemetryService, type TelemetryEventProperties } from './service';

type FailureEmitter = Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>;
interface FailureWebContents extends FailureEmitter {
  readonly id: number;
}
interface FailureHookSources {
  readonly app: FailureEmitter;
  readonly process: FailureEmitter;
  readonly existingWebContents?: readonly FailureWebContents[];
}
interface FailureReport {
  readonly error: Error;
  readonly revision: number;
  readonly properties: TelemetryEventProperties;
  readonly webContentsId?: number;
}

/** Install before opening windows. This boundary observes failures; it never
 * changes Electron/Node exit behavior or guarantees delivery after a crash. */
export const registerFailureHooks = (sources: FailureHookSources) =>
  Effect.gen(function* () {
    const telemetry = yield* TelemetryService;
    const windows = yield* WindowRegistry;
    const log = (yield* MainLogger).scopedSync('failures');
    const reports = yield* Queue.sliding<FailureReport>(32);

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(reports).pipe(
          Effect.flatMap(report =>
            Effect.gen(function* () {
              const identity =
                report.webContentsId === undefined
                  ? Option.none()
                  : yield* windows.identityForWebContents(report.webContentsId);
              yield* telemetry.captureException(
                report.error,
                {
                  ...report.properties,
                  ...(Option.isSome(identity) ? { window_type: identity.value.kind } : {}),
                },
                'main',
                report.revision
              );
            }).pipe(Effect.catchAllCause(() => Effect.void))
          )
        )
      )
    );

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let active = true;
        const attached = new Map<FailureWebContents, () => void>();
        const report = (
          error: unknown,
          message: string,
          properties: TelemetryEventProperties,
          webContentsId?: number
        ) => {
          if (!active) return;
          const safeError = projectTelemetryException(
            error,
            webContentsId === undefined ? 'main' : 'renderer'
          );
          // Immediate local evidence also works in uncaughtExceptionMonitor. Remote
          // work is queued separately and may not run before Node terminates.
          try {
            log.error(message, { context: { ...properties }, error: safeError });
          } catch {
            /* Logging cannot replace the original failure. */
          }
          const policy = Effect.runSync(SubscriptionRef.get(telemetry.state));
          if (policy.enabled)
            Queue.unsafeOffer(reports, {
              error: safeError,
              properties,
              webContentsId,
              revision: policy.revision,
            });
        };
        const attach = (contents: FailureWebContents) => {
          if (!active || attached.has(contents)) return;
          const gone = (_event: unknown, details: RenderProcessGoneDetails) => {
            if (details.reason === 'clean-exit') return;
            report(
              new Error('Renderer process exited unexpectedly'),
              'renderer process failed',
              {
                source: 'renderer-process',
                reason: details.reason,
                exit_code: details.exitCode,
              },
              contents.id
            );
          };
          const preload = (_event: unknown, _preloadPath: string, error: Error) => {
            report(error, 'preload failed', { source: 'preload' }, contents.id);
          };
          const load = (
            _event: unknown,
            errorCode: number,
            _description: string,
            _url: string,
            isMainFrame: boolean
          ) => {
            // ERR_ABORTED is normal when navigation is superseded/cancelled.
            if (errorCode === -3 || !isMainFrame) return;
            report(
              new Error('Window failed to load'),
              'window load failed',
              {
                source: 'window-load',
                exit_code: errorCode,
              },
              contents.id
            );
          };
          const detach = () => {
            contents.removeListener('render-process-gone', gone);
            contents.removeListener('preload-error', preload);
            contents.removeListener('did-fail-load', load);
            contents.removeListener('destroyed', detach);
            attached.delete(contents);
          };
          attached.set(contents, detach);
          contents.on('render-process-gone', gone);
          contents.on('preload-error', preload);
          contents.on('did-fail-load', load);
          contents.on('destroyed', detach);
        };
        const created = (_event: unknown, contents: FailureWebContents) => attach(contents);
        const childGone = (_event: unknown, details: Details) => {
          if (details.reason === 'clean-exit') return;
          report(new Error('Child process exited unexpectedly'), 'child process failed', {
            source: 'child-process',
            reason: details.reason,
            exit_code: details.exitCode,
            process_type: details.type,
          });
        };
        const uncaught = (error: Error, origin: string) => {
          report(error, 'uncaught main process exception', {
            source: 'main-process',
            error_context:
              origin === 'unhandledRejection' ? 'unhandled_rejection' : 'uncaught_exception',
          });
        };
        sources.app.on('web-contents-created', created);
        sources.app.on('child-process-gone', childGone);
        sources.process.on('uncaughtExceptionMonitor', uncaught);
        for (const contents of sources.existingWebContents ?? []) attach(contents);
        return () => {
          active = false;
          sources.app.removeListener('web-contents-created', created);
          sources.app.removeListener('child-process-gone', childGone);
          sources.process.removeListener('uncaughtExceptionMonitor', uncaught);
          for (const detach of [...attached.values()]) detach();
        };
      }),
      remove => Effect.sync(remove)
    );
  });
