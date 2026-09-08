/**
 * FloatBridge — the boot-scoped coordinator for the floating
 * note (the dock's expanded mode). It owns THE SLOT — the note the float last
 * held this session — and the locked slot semantics:
 *
 *   ✕ collapse   keeps the slot (never lossy: reopening restores the note);
 *   ⇱ dock-back  clears the slot (the note went home; main focuses on it);
 *   app restart  clears it (session-scoped, nothing persisted).
 *
 * `open(noteId)`:
 *   - explicit noteId  → that note becomes the slot;
 *   - null             → the slot's note, or a slot-less float (the float view
 *                        resolves it: the live recording's note, else a fresh
 *                        quick note it creates and reports back via open(id)).
 *
 * The observable `state` ({open, noteId}) is what the float:state push fans to
 * the app windows (pop-out button state, PiP↔docked toggling). The registry's
 * onClosed callback keeps `open` honest on EVERY close path, including an
 * OS-initiated close the verbs never saw.
 */
import { OrganizationsResponseSchema } from '@prismical/api-contracts/apps/v1';
import { Context, Effect, Layer, SubscriptionRef } from 'effect';
import { CHANNELS, type FloatStateView, type NavPush } from '@prismical/desktop-contracts';
import { AppModeService } from '../app-mode/service';
import { AuthService } from '../auth/service';
import { MainLogger } from '../../infra/logging/service';
import { RecordingBridge } from '../recording/bridge';
import { WorkspaceTransport } from '../transport/service';
import { WindowRegistry } from './service';

/**
 * Dock-initiated open behavior (the expansion rule):
 *  - `fresh`     — bypass the slot AND the live recording: the float view
 *                  always creates a brand-new quick note (pill 〜 Record,
 *                  detection-card Take Notes — "a fresh recording gets its
 *                  own new note").
 *  - `autoStart` — the float view starts a recording on that note once it
 *                  resolves (renderer-side start, so the recording is
 *                  note-associated from the first frame).
 * Both ride the route's query string; the renderer consumes them once.
 */
export interface FloatOpenOptions {
  readonly fresh?: boolean;
  readonly autoStart?: boolean;
}

export interface FloatBridgeApi {
  /** The observable slot state — replayed to new subscribers of `.changes`. */
  readonly state: SubscriptionRef.SubscriptionRef<FloatStateView>;
  /**
   * Open/focus the float on `noteId` (null = the slot / slot-less). Resolves
   * `false` when the float did NOT open (no active account, plan gate, window-create
   * failure) — dock-initiated callers keep their affordance on false.
   */
  readonly open: (noteId: string | null, options?: FloatOpenOptions) => Effect.Effect<boolean>;
  /** Close the float window; the slot survives. */
  readonly collapse: Effect.Effect<void>;
  /** Close the float, focus main on the slot's note, clear the slot. */
  readonly dockBack: Effect.Effect<void>;
  /**
   * Sign-out teardown: close the window AND clear the slot (the slot is a
   * note id belonging to the departing account — it must not leak into the
   * next session's float).
   */
  readonly reset: Effect.Effect<void>;
}

export class FloatBridge extends Context.Tag('desktop/windows/FloatBridge')<
  FloatBridge,
  FloatBridgeApi
>() {}

export const FloatBridgeLive: Layer.Layer<
  FloatBridge,
  never,
  WindowRegistry | RecordingBridge | AuthService | AppModeService | MainLogger | WorkspaceTransport
> = Layer.effect(
    FloatBridge,
    Effect.gen(function* () {
      const windows = yield* WindowRegistry;
      const recording = yield* RecordingBridge;
      const auth = yield* AuthService;
      const transport = yield* WorkspaceTransport;
      const { mode } = yield* AppModeService;
      const log = (yield* MainLogger).scoped('float');

      const state = yield* SubscriptionRef.make<FloatStateView>({ open: false, noteId: null });

      // EVERY close path lands here (collapse, dock-back, an OS close): the
      // slot is left alone — only dockBack clears it, explicitly, below.
      // Synchronous SubscriptionRef.update — safe on this Electron event edge
      // (same rationale as the focus callbacks in windows/live.ts).
      const onClosed = () => {
        Effect.runSync(SubscriptionRef.update(state, current => ({ ...current, open: false })));
      };

      const api: FloatBridgeApi = {
        state,
        open: (noteId, options) =>
          Effect.gen(function* () {
            if (mode !== 'local') {
              const before = yield* SubscriptionRef.get(auth.sessionState);
              const account =
                before.activeSub === undefined ? undefined : before.accounts[before.activeSub];
              if (account === undefined) {
                yield* log.info('float open ignored — no active account');
                return false;
              }
              // Slot resolution calls open again after creating a note. An already
              // visible window needs no second lookup; collapsed windows do.
              if (account.activeOrgId !== undefined && !(yield* SubscriptionRef.get(state)).open) {
                const response = yield* transport.request(
                  { method: 'GET', path: '/apps/v1/me/organizations' },
                  { mode: 'cloud', sessionState: auth.sessionState }
                );
                // A response from a switched-away account/org must never open a window.
                const after = yield* SubscriptionRef.get(auth.sessionState);
                const active =
                  after.activeSub === undefined ? undefined : after.accounts[after.activeSub];
                if (active?.sub !== account.sub || active.activeOrgId !== account.activeOrgId) {
                  return false;
                }
                const parsed =
                  'ok' in response && response.status === 200
                    ? OrganizationsResponseSchema.safeParse(response.bodyJson)
                    : null;
                const org = parsed?.success
                  ? parsed.data.results.find(org => org.orgId === account.activeOrgId)
                  : undefined;
                if (org === undefined) {
                  yield* log.warn('float open ignored — plan unavailable');
                  return false;
                }
                if (org.entitlements?.features.floatingMode === false) {
                  const payload: NavPush = {
                    path: '/settings/billing',
                    notice: 'floating-mode-unavailable',
                  };
                  yield* windows.sendToMainWindow(CHANNELS.navPush, payload);
                  yield* windows.focusMainWindow;
                  return false;
                }
              }
            }
            const fresh = options?.fresh === true;
            const autoStart = options?.autoStart === true;
            const current = yield* SubscriptionRef.get(state);
            // Slot resolution, MAIN-side (never a renderer push-buffer race):
            // explicit note → the slot → the LIVE recording's note → null
            // (the float view then creates a fresh quick note and reports it
            // back through this same verb). `fresh` bypasses ALL of it — the
            // dock-initiated start gets its own brand-new note.
            const slot = fresh ? null : noteId ?? current.noteId ?? (yield* recording.activeNoteId);
            const search =
              fresh || autoStart
                ? `?${[fresh ? 'fresh=1' : null, autoStart ? 'autostart=1' : null]
                    .filter(Boolean)
                    .join('&')}`
                : '';
            // A LIVE window (visible or collapse-HIDDEN — collapse keeps the
            // renderer alive since the keep-alive change) may be showing a
            // different note than requested — or the same note with a live
            // autostart intent to deliver — so retarget its route first; the
            // registry open below is then just a show+focus. The slot always
            // mirrors what a live window shows (collapse keeps both; dockBack
            // and reset DESTROY the window as they clear it), so comparing
            // against the slot is comparing against the window's route.
            // sendToFloatNoteWindow is a no-op false when no window is live.
            // (A retarget racing a NEW window's INITIAL load can drop this
            // push — the nav buffer attaches at preload eval; rare enough to
            // accept, revisit in a hardening pass.)
            if (fresh) {
              const payload: NavPush = { path: `/float${search}` };
              yield* windows.sendToFloatNoteWindow(CHANNELS.navPush, payload);
            } else if (slot !== null && (slot !== current.noteId || autoStart)) {
              const payload: NavPush = { path: `/float/${slot}${search}` };
              yield* windows.sendToFloatNoteWindow(CHANNELS.navPush, payload);
            }
            const opened = yield* windows
              .openFloatNoteWindow({ noteId: slot, search, onClosed })
              .pipe(
                Effect.as(true),
                Effect.catchTag('WindowError', error =>
                  log.error('float open failed', { context: { stage: error.stage } }).pipe(Effect.as(false))
                )
              );
            // `fresh` transiently clears the slot; the float view reports the
            // created note back through open(id), which restores it.
            if (opened) yield* SubscriptionRef.set(state, { open: true, noteId: slot });
            return opened;
          }),
        // Collapse HIDES (keep-alive): the renderer stays mounted — live Yjs
        // doc, warm note query, laid-out cluster — so the next open is an
        // instant show instead of a full window rebuild + reload. Only
        // dockBack/reset destroy (they clear the slot, and a kept-alive
        // window would go stale against it).
        collapse: windows.hideFloatNoteWindow.pipe(
          Effect.zipRight(
            SubscriptionRef.update(state, current => ({ ...current, open: false }))
          )
        ),
        dockBack: Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          yield* windows.closeFloatNoteWindow;
          if (current.noteId !== null) {
            const payload: NavPush = { path: `/notes/${current.noteId}` };
            yield* windows.sendToMainWindow(CHANNELS.navPush, payload);
          }
          yield* windows.focusMainWindow;
          yield* SubscriptionRef.set(state, { open: false, noteId: null });
        }),
        reset: windows.closeFloatNoteWindow.pipe(
          Effect.zipRight(SubscriptionRef.set(state, { open: false, noteId: null }))
        ),
      };
      return api;
    })
  );
