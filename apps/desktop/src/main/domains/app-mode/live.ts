import { Effect, Layer } from 'effect';
import { MainLogger } from '../../infra/logging/service';
import { OperationalDb } from '../../infra/operational-db/service';
import { restoreAuthState } from '../auth/policy';
import { AppModeService, type AppMode, type AppModeApi } from './service';

/**
 * Operational KV key holding the chosen mode. Own namespace — deliberately NOT
 * a `pref:` DeviceSettings field: the mode is boot-structural state read BEFORE
 * the workspace lifecycle starts, and SettingsService.reset (the app
 * reset) must not silently flip a device between modes. Written by the
 * first-run chooser (capability:chooseAppMode) and the mode switch
 * (capability:resetApp with a mode); a plain reset keeps it.
 */
export const APP_MODE_KEY = 'app:mode';

/**
 * The persisted account roster (AuthServiceLive's ACCOUNT_INDEX_KEY — the
 * same literal; re-declared here so the boot-structural mode layer does not
 * import the auth service module). An install that signed in before the mode
 * existed has accounts but no `app:mode` row:
 * it is a CLOUD install that implicitly chose, never a first run — showing
 * the chooser over a restored session, or letting it relaunch into local mode
 * with cloud refresh tokens still in the secure store, would be wrong. The
 * row is written to make that explicit for every later boot.
 */
const ACCOUNT_INDEX_KEY = 'auth.accounts';

const isAppMode = (value: string | null): value is AppMode =>
  value === 'local' || value === 'cloud';

/**
 * Boot-scoped AppMode resolution. Read-only and
 * infallible: a missing, malformed or unreadable row falls back to 'cloud'
 * (today's only real mode) and never blocks boot — mirroring the
 * SettingsService boot-read discipline.
 */
export const AppModeLive: Layer.Layer<AppModeService, never, OperationalDb | MainLogger> =
  Layer.effect(
    AppModeService,
    Effect.gen(function* () {
      const db = yield* OperationalDb;
      const log = (yield* MainLogger).scoped('app-mode');

      const stored = yield* db.getSetting(APP_MODE_KEY).pipe(
        Effect.catchTag('DbError', error =>
          log
            .warn('app-mode read failed at boot — defaulting to cloud', { op: error.op })
            .pipe(Effect.as(null))
        )
      );
      if (isAppMode(stored)) {
        yield* log.info('app mode resolved', { mode: stored, chosen: true });
        const api: AppModeApi = { mode: stored, chosen: true };
        return api;
      }

      // No (valid) row: a signed-in roster means an upgraded cloud install —
      // implicitly chosen. Persist that so the next boot needs no inference.
      const accountIndex = yield* db.getSetting(ACCOUNT_INDEX_KEY).pipe(
        Effect.catchTag('DbError', () => Effect.succeed(null))
      );
      const hasAccounts = Object.keys(restoreAuthState(accountIndex).accounts).length > 0;
      if (hasAccounts) {
        yield* db.setSetting(APP_MODE_KEY, 'cloud').pipe(
          Effect.catchTag('DbError', error =>
            log.warn('app mode self-heal write failed', { op: error.op })
          )
        );
        yield* log.info('app mode resolved', { mode: 'cloud', chosen: true, inferred: 'accounts' });
        const api: AppModeApi = { mode: 'cloud', chosen: true };
        return api;
      }

      const mode: AppMode = 'cloud';
      yield* log.info('app mode resolved', { mode, chosen: false });
      const api: AppModeApi = { mode, chosen: false };
      return api;
    })
  );
