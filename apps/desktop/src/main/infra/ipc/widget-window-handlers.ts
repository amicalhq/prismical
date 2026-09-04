/**
 * Widget-window IPC membrane — the floating widget's boot-scoped
 * side, the exact analogue of main-window-handlers.ts but with a deliberately
 * tiny surface: one state snapshot/stream plus fire-and-forget command
 * verbs (including the drag pair), and nothing else (no
 * env/auth/transport/e2e). Every
 * handler:
 *   1. validates event.sender against the WindowRegistry identity table — the
 *      sender must be the registered widget window, else a typed rejection + warn;
 *   2. (setInteractive only) zod-parses its payload;
 *   3. bridges into the Effect runtime and reaches the CURRENT session through the
 *      boot-scoped RecordingBridge / DetectionBridge (no live session ⇒ a graceful
 *      no-op, never a throw).
 *
 * The single push fiber combines the four reactive sources the pill depends on —
 * cross-session recording state, cross-session detection, main-window focus, and
 * the user's 3-way visibility setting — with latest-wins semantics
 * (Stream.zipLatestAll), projects each combination through the pure
 * `toWidgetState`, dedupes consecutive-identical projections, and fans the
 * sanitized WidgetStateView out to the widget renderer.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  WIDGET_CHANNELS,
  parseSetInteractiveRequest,
  parseWidgetDrag,
  parseWidgetLevel,
  parseWidgetState,
  type WidgetStateView,
} from '@prismical/desktop-contracts';
import { Deferred, Effect, Option, Ref, Runtime, Stream, type Scope } from 'effect';
import { toWidgetState } from '../../domains/detection/widget-policy';
import { DesktopI18n } from '../../domains/i18n/service';
import { RecordingBridge } from '../../domains/recording/bridge';
import { SettingsService } from '../../domains/settings/service';
import { FloatBridge } from '../../domains/windows/float-bridge';
import { WindowRegistry } from '../../domains/windows/service';
import { AppConfig } from '../config/service';
import { MainLogger } from '../logging/service';

// AppConfig rides the runtime env for parity with the main-window membrane (and
// keeps this membrane's requirement set aligned with the boot graph) even though
// the tight widget surface never reads config directly. SettingsService feeds the
// widget-visibility policy + persists the drag anchor.
// DetectionBridge left this membrane — detection talks to the
// NOTIFY window now (notify-window-handlers.ts); the pill is detection-blind.
type WidgetHandlerEnv =
  | WindowRegistry
  | RecordingBridge
  | SettingsService
  | FloatBridge
  | DesktopI18n
  | MainLogger
  | AppConfig;

class SenderRejected extends Error {
  constructor(readonly code: 'UNKNOWN_SENDER') {
    super('UNKNOWN_SENDER');
    this.name = 'SenderRejected';
  }
}

class PayloadRejected extends Error {
  constructor(readonly code: 'INVALID_REQUEST') {
    super('INVALID_REQUEST');
    this.name = 'PayloadRejected';
  }
}

/**
 * Two projections are display-equal — dedupe consecutive-identical pushes so a
 * churny upstream (repeated focus/blur, duplicate session pushes) doesn't spam
 * the renderer. Compares only the fields the pill reads.
 */
const sameWidgetState = (a: WidgetStateView, b: WidgetStateView): boolean =>
  a.visible === b.visible &&
  a.mode === b.mode &&
  a.recording?.status === b.recording?.status &&
  a.recording?.micOnly === b.recording?.micOnly &&
  a.recording?.canPause === b.recording?.canPause &&
  a.recording?.startedAt === b.recording?.startedAt &&
  a.recording?.pausedAccumMs === b.recording?.pausedAccumMs &&
  a.recording?.elapsedMs === b.recording?.elapsedMs &&
  a.recording?.elapsedAt === b.recording?.elapsedAt;

export const registerWidgetWindowHandlers: Effect.Effect<
  void,
  never,
  WidgetHandlerEnv | Scope.Scope
> = Effect.gen(function* () {
  const windows = yield* WindowRegistry;
  const recording = yield* RecordingBridge;
  const settings = yield* SettingsService;
  const floatBridge = yield* FloatBridge;
  const i18n = yield* DesktopI18n;
  const log = (yield* MainLogger).scoped('widget-ipc');

  const runtime = yield* Effect.runtime<WidgetHandlerEnv>();
  const runPromise = Runtime.runPromise(runtime);
  const firstState = yield* Deferred.make<WidgetStateView>();
  const latestState = yield* Ref.make<WidgetStateView | null>(null);

  /** Sender must be the registered widget window. */
  const validateWidgetSender = (event: IpcMainInvokeEvent): Effect.Effect<void, SenderRejected> =>
    windows
      .identityForWebContents(event.sender.id)
      .pipe(
        Effect.flatMap(identity =>
          Option.isSome(identity) && identity.value.kind === 'widget'
            ? Effect.void
            : log
                .warn('widget ipc rejected: unknown sender', { webContentsId: event.sender.id })
                .pipe(Effect.zipRight(Effect.fail(new SenderRejected('UNKNOWN_SENDER'))))
        )
      );

  const acquireHandle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, payload?: unknown) => Promise<unknown>
  ) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        ipcMain.handle(channel, handler);
      }),
      () =>
        Effect.sync(() => {
          ipcMain.removeHandler(channel);
        })
    );

  // widget:state:get — a guaranteed cold-start snapshot. The push stream may
  // emit before the panel preload exists; retain its latest sanitized value and
  // let an exceptionally early pull wait for the first projection.
  yield* acquireHandle(WIDGET_CHANNELS.stateGet, event =>
    runPromise(
      validateWidgetSender(event).pipe(
        Effect.zipRight(
          Ref.get(latestState).pipe(
            Effect.flatMap(state =>
              state === null ? Deferred.await(firstState) : Effect.succeed(state)
            )
          )
        )
      )
    )
  );

  // widget:setInteractive — toggle the click-through window's interactivity on
  // hit-zone hover/leave. `interactive: true` ⇒ ignoreMouse false (clickable).
  yield* acquireHandle(WIDGET_CHANNELS.setInteractive, (event, payload) =>
    runPromise(
      validateWidgetSender(event).pipe(
        Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
          const parsed = parseSetInteractiveRequest(payload);
          if (!parsed.success) {
            return log
              .warn('widget:setInteractive rejected: invalid payload', { issues: parsed.issues })
              .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
          }
          return windows.setWidgetIgnoreMouse(!parsed.data.interactive);
        })
      )
    )
  );

  // widget:startRecording — the pill's 〜 Record. The expansion rule:
  // a dock-initiated start ALWAYS expands — open the float on a FRESH note
  // with autostart; the float view creates the note and starts the recording
  // against it (note-associated from the first frame, unlike the old
  // noteId-null main-side start). The pill flips to recording via the normal
  // state push once the recording begins.
  yield* acquireHandle(WIDGET_CHANNELS.startRecording, event =>
    runPromise(
      validateWidgetSender(event).pipe(
        Effect.zipRight(floatBridge.open(null, { fresh: true, autoStart: true })),
        Effect.flatMap(opened =>
          opened
            ? log.info('widget:startRecording expanded the float (fresh + autostart)')
            : log.warn('widget:startRecording — float did not open, nothing started')
        )
      )
    )
  );

  // widget:stopRecording — the pill's "Stop": stop whatever recording is active
  // (the widget never learns the recordingId). A no-op when nothing is in flight.
  yield* acquireHandle(WIDGET_CHANNELS.stopRecording, event =>
    runPromise(validateWidgetSender(event).pipe(Effect.zipRight(recording.stopActive)))
  );

  // widget:pauseRecording / widget:resumeRecording — the widget never learns
  // the recording id, so the bridge targets the active native recording.
  yield* acquireHandle(WIDGET_CHANNELS.pauseRecording, event =>
    runPromise(validateWidgetSender(event).pipe(Effect.zipRight(recording.pauseActive)))
  );
  yield* acquireHandle(WIDGET_CHANNELS.resumeRecording, event =>
    runPromise(validateWidgetSender(event).pipe(Effect.zipRight(recording.resumeActive)))
  );

  // widget:expandNote — the pill's 📓: open the floating note
  // on the slot (the FloatBridge resolves last-floated / fresh-quick-note).
  yield* acquireHandle(WIDGET_CHANNELS.expandNote, event =>
    runPromise(
      validateWidgetSender(event).pipe(Effect.zipRight(floatBridge.open(null)), Effect.asVoid)
    )
  );

  // widget:openMain — the recording pill's "Open note": focus the main window.
  // MVP focuses only; navigating to the recording's note is a deferred nicety.
  yield* acquireHandle(WIDGET_CHANNELS.openMain, event =>
    runPromise(validateWidgetSender(event).pipe(Effect.zipRight(windows.focusMainWindow)))
  );

  // widget:dragMove / widget:dragEnd — 2-axis drag-to-reposition. Both apply the
  // sample through the registry (pointer-display bands +
  // magnetic edge snap, pure math in dock-geometry.ts); dragEnd ALSO persists
  // the per-display anchor (`dockAnchors[displayId]`) and the display the dock
  // now lives on (`dockDisplayId`). Dragging is high-frequency so ONLY the
  // release is persisted — dragMove repositions live but never writes. A
  // missing widget (Option.none) is a graceful no-op.
  const applyDrag = (payload: unknown, persist: boolean): Effect.Effect<void, PayloadRejected> => {
    const parsed = parseWidgetDrag(payload);
    if (!parsed.success) {
      return log
        .warn('widget:drag rejected: invalid payload', { issues: parsed.issues })
        .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
    }
    return windows.dragDockWindow(parsed.data).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ anchor, displayId }) =>
            persist
              ? settings.get.pipe(
                  Effect.flatMap(current =>
                    settings.set({
                      dockAnchors: { ...current.dockAnchors, [displayId]: anchor },
                      dockDisplayId: displayId,
                    })
                  ),
                  // A persist failure must not fail the reposition (already
                  // applied); log and move on — the next dragEnd retries.
                  Effect.catchTag('DbError', error =>
                    log.warn('widget:dragEnd persist failed', { op: error.op })
                  )
                )
              : Effect.void,
        })
      )
    );
  };

  yield* acquireHandle(WIDGET_CHANNELS.dragMove, (event, payload) =>
    runPromise(validateWidgetSender(event).pipe(Effect.flatMap(() => applyDrag(payload, false))))
  );
  yield* acquireHandle(WIDGET_CHANNELS.dragEnd, (event, payload) =>
    runPromise(validateWidgetSender(event).pipe(Effect.flatMap(() => applyDrag(payload, true))))
  );

  // The widget:level gate: true while the last projected state
  // was a visible recording pill — the state push fiber below maintains it, the
  // level fiber reads it per emission. A plain Ref (not a stream zip) so the
  // high-frequency level lane never re-runs the projection.
  const levelGate = yield* Ref.make(false);

  // widget:state — the scoped push fiber. zipLatestAll gives latest-wins over the
  // three sources: any one emitting re-projects with the others' latest. Re-parsed
  // through the schema (belt-and-braces, mirroring the main-window push): a
  // token-shaped field would be stripped, and a structurally-invalid view is
  // dropped loudly rather than crossing the membrane. A webContents.send racing
  // window destruction throws a DEFECT — logged so the fiber survives the process
  // lifetime, exactly like the main-window push fibers.
  yield* Effect.forkScoped(
    Stream.zipLatestAll(
      recording.stateChanges,
      windows.mainWindowFocused.changes,
      // The user's 3-way visibility setting. Projected down to just the
      // `widgetVisibility` string + deduped so a non-visibility settings change
      // (language, dock, …) never churns the widget push.
      settings.settings.changes.pipe(
        Stream.map(current => current.widgetVisibility),
        Stream.changes
      )
    ).pipe(
      Stream.map(([rec, focused, visibility]) => ({
        locale: i18n.locale,
        ...toWidgetState(rec, focused, visibility),
      })),
      Stream.tap(view => Ref.set(levelGate, view.visible && view.mode === 'recording')),
      Stream.changesWith(sameWidgetState),
      Stream.runForEach(view => {
        const parsed = parseWidgetState(view);
        const push = parsed.success
          ? Ref.set(latestState, parsed.data).pipe(
              Effect.zipRight(Deferred.succeed(firstState, parsed.data)),
              Effect.zipRight(
                windows
                  .sendToWidgetWindow(WIDGET_CHANNELS.stateStream, parsed.data)
                  .pipe(Effect.asVoid)
              )
            )
          : log.error('widget:state push dropped: view failed the schema', {
              issues: parsed.issues,
            });
        return push.pipe(
          Effect.catchAllDefect(defect =>
            log.error('widget:state push failed — fiber continues', { defect: String(defect) })
          )
        );
      })
    )
  );

  // widget:level — the throttled waveform lane: the bridge's
  // cross-session level stream, quantized (2 decimals) + deduped so a silent
  // room doesn't spam identical values, throttled to ≤12.5 Hz ('enforce' DROPS
  // excess rather than queueing — a stale level is worthless), and gated on the
  // last projection being a visible recording pill. Same defect stance as the
  // state push: the fiber survives a send racing window destruction.
  yield* Effect.forkScoped(
    recording.levelChanges.pipe(
      Stream.map(level => Math.round(Math.min(1, Math.max(0, level)) * 100) / 100),
      Stream.changes,
      // Cost by CHUNK SIZE, not per-chunk: a batched-up chunk of pending levels
      // must not ride one token past the ≤12.5 Hz budget.
      Stream.throttle({
        cost: chunk => chunk.length,
        units: 1,
        duration: '80 millis',
        strategy: 'enforce',
      }),
      Stream.runForEach(level =>
        Ref.get(levelGate).pipe(
          Effect.flatMap(open => {
            if (!open) return Effect.void;
            const parsed = parseWidgetLevel({ level });
            return parsed.success
              ? windows
                  .sendToWidgetWindow(WIDGET_CHANNELS.levelStream, parsed.data)
                  .pipe(Effect.asVoid)
              : log.warn('widget:level push dropped: payload failed the schema', {
                  issues: parsed.issues,
                });
          }),
          Effect.catchAllDefect(defect =>
            log.error('widget:level push failed — fiber continues', { defect: String(defect) })
          )
        )
      )
    )
  );

  // Settings-reactive dock plumbing:
  //  - "reset dock position" clears dockAnchors/dockDisplayId/floatNoteBounds
  //    — the live pill AND a live float snap back to their seeded spots. The
  //    trigger is RESET-SHAPED (everything cleared), never "any anchor
  //    change": a dragEnd's own persist must not re-enter setBounds behind
  //    the drag (today the anchor→bounds round-trip is exact, but the fiber
  //    must not depend on that staying true);
  //  - "hide dock from screen sharing" applies setContentProtection to every
  //    dock-family window live (new windows self-apply at create).
  // Both drop(1) the boot snapshot: the window already opened with these
  // values applied, and a boot-time re-apply RACES a concurrent drag's
  // setBounds — only genuine changes act.
  yield* Effect.forkScoped(
    settings.settings.changes.pipe(
      Stream.map(current => ({
        anchors: current.dockAnchors,
        displayId: current.dockDisplayId,
        floatBounds: current.floatNoteBounds,
      })),
      Stream.changesWith(
        (a, b) =>
          a.displayId === b.displayId &&
          JSON.stringify(a.anchors) === JSON.stringify(b.anchors) &&
          JSON.stringify(a.floatBounds) === JSON.stringify(b.floatBounds)
      ),
      Stream.drop(1),
      Stream.filter(
        current =>
          Object.keys(current.anchors).length === 0 &&
          current.displayId === null &&
          Object.keys(current.floatBounds).length === 0
      ),
      Stream.runForEach(() =>
        windows.repositionDockWindow.pipe(
          Effect.zipRight(windows.repositionFloatNoteWindow),
          Effect.catchAllDefect(defect =>
            log.error('dock reposition failed — fiber continues', { defect: String(defect) })
          )
        )
      )
    )
  );
  yield* Effect.forkScoped(
    settings.settings.changes.pipe(
      Stream.map(current => current.dockContentProtection),
      Stream.changes,
      Stream.drop(1),
      Stream.runForEach(enabled =>
        windows.setDockContentProtection(enabled).pipe(
          Effect.catchAllDefect(defect =>
            log.error('dock content protection apply failed — fiber continues', {
              defect: String(defect),
            })
          )
        )
      )
    )
  );

  yield* log.info('widget-window ipc handlers registered');
});
