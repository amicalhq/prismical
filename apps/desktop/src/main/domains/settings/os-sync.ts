/**
 * OS-preference sync consumer. A boot-scoped consumer that
 * projects the two OS-facing device settings — `launchAtLogin` and `dockVisible`
 * — onto the real OS through the NativeOs edge, reactively.
 *
 * `SubscriptionRef.changes` replays the CURRENT value to a new subscriber
 * immediately, so mapping to a field + `Stream.changes` (dedupes consecutive
 * equal values) means each side-effect fires exactly (a) once on boot — the
 * OS ↔ persisted reconcile — and (b) whenever THAT field changes, and never on
 * an unrelated settings change. Mirrors the widget-visibility re-projection.
 *
 * Two scalar streams keep each apply independent; the SettingsService stays
 * electron-free and the OS edge stays the single injectable boundary (a fake
 * NativeOs drives the test).
 *
 * Each apply is wrapped in `catchAllDefect` — the NativeOs edge is an
 * `Effect.sync` over the `app` singleton (setLoginItemSettings / dock) with no
 * declared error channel, but a native call CAN throw a defect on some OS/version
 * edge; without the guard that defect would kill the forkScoped consumer
 * SILENTLY and PERMANENTLY (the setting would stop projecting for the whole
 * process lifetime). This matches every other reactive fiber in the app (the
 * settings:changed / auth / recording / widget push fibers all guard defects) —
 * a dropped apply is logged and the consumer lives on.
 */
import { Effect, Stream, type Scope } from 'effect';
import { MainLogger } from '../../infra/logging/service';
import { NativeOs } from '../../infra/native-os/service';
import { SettingsService } from './service';

export const runOsSync: Effect.Effect<
  void,
  never,
  SettingsService | NativeOs | MainLogger | Scope.Scope
> = Effect.gen(function* () {
  const settings = yield* SettingsService;
  const nativeOs = yield* NativeOs;
  const log = (yield* MainLogger).scoped('os-sync');

  // Launch at login → app.setLoginItemSettings (cross-platform).
  yield* Effect.forkScoped(
    Stream.runForEach(
      settings.settings.changes.pipe(
        Stream.map(current => current.launchAtLogin),
        Stream.changes
      ),
      openAtLogin =>
        nativeOs.setLoginItem(openAtLogin).pipe(
          Effect.catchAllDefect(defect =>
            log.error('os-sync setLoginItem failed — consumer continues', { error: defect })
          )
        )
    )
  );

  // Dock visibility → app.dock show/hide (the edge no-ops off macOS). No UI
  // control drives this today — it stays default-true, applied here on boot.
  yield* Effect.forkScoped(
    Stream.runForEach(
      settings.settings.changes.pipe(
        Stream.map(current => current.dockVisible),
        Stream.changes
      ),
      visible =>
        nativeOs.setDockVisible(visible).pipe(
          Effect.catchAllDefect(defect =>
            log.error('os-sync setDockVisible failed — consumer continues', { error: defect })
          )
        )
    )
  );
});
