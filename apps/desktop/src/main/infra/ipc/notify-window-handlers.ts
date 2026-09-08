/**
 * Notify-window IPC membrane — the notification card layer's
 * boot-scoped side, the exact analogue of widget-window-handlers.ts: a tiny
 * sanitized surface (one state push, one action verb, one interactivity
 * toggle), sender-validated against the WindowRegistry identity table.
 *
 * The card stack lives here in a SubscriptionRef:
 *  - the PRODUCER fiber projects (detection state × meetingNotifications
 *    setting) into the call-detected card via the pure notify-policy — flipping
 *    the setting off clears the card instantly;
 *  - the SWEEPER fiber ticks 1s dropping expired cards (the renderer's loader
 *    is cosmetic; expiry authority is main-side);
 *  - the PUSH fiber fans ref changes out to the notify renderer, deduped by
 *    card identity and re-parsed through the schema (belt-and-braces).
 *
 * notify:action routes: 'take-notes' → start a dual recording + remove the card
 * (the detection card's affordance — the old detection pill's Take Notes);
 * 'dismiss' (a card-body click) → remove the card AND, for a detection card,
 * apply the detection cooldown (the old pill ✕ semantics). An expired/unknown
 * card id is a graceful no-op — the renderer may race the sweeper.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  NOTIFY_CHANNELS,
  parseNotifyAction,
  parseNotifySetInteractive,
  parseNotifyState,
  type NotifyCard,
} from '@prismical/desktop-contracts';
import { Clock, Effect, Option, Ref, Runtime, Stream, SubscriptionRef, type Scope } from 'effect';
import { DetectionBridge } from '../../domains/detection/bridge';
import { DesktopI18n } from '../../domains/i18n/service';
import {
  callDetectedCard,
  AUTO_PAUSE_KEEP,
  AUTO_PAUSE_PAUSE,
  autoPauseCard,
  dropExpiredCards,
  mergeAutoPauseCard,
  mergeDetectionCard,
  sameCardStack,
} from '../../domains/detection/notify-policy';
import { RecordingBridge } from '../../domains/recording/bridge';
import { SettingsService } from '../../domains/settings/service';
import { FloatBridge } from '../../domains/windows/float-bridge';
import { WindowRegistry } from '../../domains/windows/service';
import { AppConfig } from '../config/service';
import { MainLogger } from '../logging/service';

type NotifyHandlerEnv =
  | WindowRegistry
  | DetectionBridge
  | FloatBridge
  | RecordingBridge
  | SettingsService
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

export const registerNotifyWindowHandlers: Effect.Effect<
  void,
  never,
  NotifyHandlerEnv | Scope.Scope
> = Effect.gen(function* () {
  const windows = yield* WindowRegistry;
  const detection = yield* DetectionBridge;
  const floatBridge = yield* FloatBridge;
  const recordingBridge = yield* RecordingBridge;
  const settings = yield* SettingsService;
  const i18n = yield* DesktopI18n;
  // Auto-pause card actions. Both route into the recording domain and let the
  // resulting state push retract the card, so the card and the session can never disagree.
  const keepRecordingNow = recordingBridge.keepRecordingActive;
  const pauseNow = recordingBridge.pauseFromPromptActive;
  const log = (yield* MainLogger).scoped('notify-ipc');

  const runtime = yield* Effect.runtime<NotifyHandlerEnv>();
  const runPromise = Runtime.runPromise(runtime);

  const cards = yield* SubscriptionRef.make<readonly NotifyCard[]>([]);
  // The last call-detected card id the SWEEPER expired: the producer must not
  // resurrect it on an unrelated re-emission of the SAME detection (the
  // detection domain dedupes its own churn today, but this invariant must not
  // rest on another module's dedupe). A new detection (fresh detectedAt) mints
  // a new id and cards normally; a settings off→on re-card is a merge(null)
  // clear, not an expiry, so it stays intended behavior.
  const expiredDetectionCardId = yield* Ref.make<string | null>(null);

  /** Sender must be the registered notify window. */
  const validateNotifySender = (event: IpcMainInvokeEvent): Effect.Effect<void, SenderRejected> =>
    windows
      .identityForWebContents(event.sender.id)
      .pipe(
        Effect.flatMap(identity =>
          Option.isSome(identity) && identity.value.kind === 'notify'
            ? Effect.void
            : log
                .warn('notify ipc rejected: unknown sender', { context: { webContentsId: event.sender.id } })
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

  const removeCard = (cardId: string): Effect.Effect<void> =>
    SubscriptionRef.update(cards, current => current.filter(card => card.id !== cardId));

  const currentState = SubscriptionRef.get(cards).pipe(
    Effect.map(stack => {
      const parsed = parseNotifyState({ locale: i18n.locale, cards: stack });
      if (!parsed.success) {
        throw new Error('notify state failed its schema');
      }
      return parsed.data;
    })
  );

  // notify:state:get — a guaranteed cold-start snapshot. The initial empty-card
  // push can predate preload evaluation, so renderer boot must not depend on it.
  yield* acquireHandle(NOTIFY_CHANNELS.stateGet, event =>
    runPromise(validateNotifySender(event).pipe(Effect.zipRight(currentState)))
  );

  // notify:setInteractive — click-through toggle on card hover, like the
  // widget's. Main-side guard: interactivity is never granted while the card
  // stack is EMPTY — a renderer that crashed (or misbehaves) mid-hover must
  // not leave an invisible click-eating region in the screen corner.
  yield* acquireHandle(NOTIFY_CHANNELS.setInteractive, (event, payload) =>
    runPromise(
      validateNotifySender(event).pipe(
        Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
          const parsed = parseNotifySetInteractive(payload);
          if (!parsed.success) {
            return log
              .warn('notify:setInteractive rejected: invalid payload', { context: { issues: parsed.issues } })
              .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
          }
          if (!parsed.data.interactive) return windows.setNotifyIgnoreMouse(true);
          return SubscriptionRef.get(cards).pipe(
            Effect.flatMap(current =>
              current.length === 0 ? Effect.void : windows.setNotifyIgnoreMouse(false)
            )
          );
        })
      )
    )
  );

  // notify:action — a card button press or a card-body dismiss.
  yield* acquireHandle(NOTIFY_CHANNELS.action, (event, payload) =>
    runPromise(
      validateNotifySender(event).pipe(
        Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
          const parsed = parseNotifyAction(payload);
          if (!parsed.success) {
            return log
              .warn('notify:action rejected: invalid payload', { context: { issues: parsed.issues } })
              .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
          }
          const { cardId, actionId } = parsed.data;
          return SubscriptionRef.get(cards).pipe(
            Effect.flatMap(current => {
              const card = current.find(c => c.id === cardId);
              // Expired/foreign card id: graceful no-op (renderer races the sweeper).
              if (card === undefined) return Effect.void;
              if (actionId === 'dismiss') {
                // An auto-pause dismiss means KEEP RECORDING, not "cancel this prompt and pause
                // anyway". Touching the card at all proves a human is present, which
                // is the exact question the silence detector was guessing at — so the ambiguous
                // interaction resolves toward NOT pausing. The card is removed by the resulting
                // state push, not here, so the two can't disagree.
                if (card.kind === 'auto-pause') return keepRecordingNow;
                // A detection card dismiss keeps the old pill-✕ semantics: the
                // per-app cooldown, so the same call doesn't re-card immediately.
                return removeCard(cardId).pipe(
                  Effect.zipRight(card.kind === 'call-detected' ? detection.dismiss : Effect.void)
                );
              }
              if (card.kind === 'auto-pause') {
                if (actionId === AUTO_PAUSE_KEEP) return keepRecordingNow;
                if (actionId === AUTO_PAUSE_PAUSE) return pauseNow;
              }
              if (actionId === 'take-notes' && card.kind === 'call-detected') {
                // The expansion rule: a dock-initiated start always
                // expands — open the float on a FRESH note with autostart (the
                // float view creates the note and starts the recording against
                // it). The card leaves only when the float actually opened
                // (a failed open keeps the
                // affordance so the user can retry instead of watching it
                // evaporate).
                return floatBridge
                  .open(null, { fresh: true, autoStart: true })
                  .pipe(
                    Effect.flatMap(opened =>
                      opened
                        ? removeCard(cardId).pipe(
                            Effect.zipRight(log.info('notify take-notes expanded the float'))
                          )
                        : log.warn('notify take-notes — float did not open, card kept')
                    )
                  );
              }
              return log.warn('notify:action ignored: unknown action for card', { context: {
                cardId,
                actionId,
                kind: card.kind,
              } });
            })
          );
        })
      )
    )
  );

  // PRODUCER — detection × the meetingNotifications setting → the card stack.
  // zipLatestAll: flipping the setting re-projects with the latest detection
  // (off clears the card instantly), and vice versa. Keeping an already-carded
  // detection's ORIGINAL card preserves its TTL across repeated emissions.
  yield* Effect.forkScoped(
    Stream.zipLatestAll(
      detection.stateChanges,
      settings.settings.changes.pipe(
        Stream.map(current => current.meetingNotifications),
        Stream.changes
      )
    ).pipe(
      Stream.runForEach(([det, enabled]) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const built =
            enabled && det.status === 'detected' && det.detection !== null
              ? callDetectedCard(det.detection, now, i18n.t)
              : null;
          // Never resurrect a card the sweeper already expired (same id).
          const expired = yield* Ref.get(expiredDetectionCardId);
          const active = built !== null && built.id === expired ? null : built;
          yield* SubscriptionRef.update(cards, current => mergeDetectionCard(current, active));
        })
      )
    )
  );

  // Producer — the recording domain's auto-pause prompt → the `auto-pause` card.
  // Deliberately the same shape as the detection producer above: the DECISION lives in the capture
  // fiber (that is where the frames are), and this layer only projects it, so the card cannot
  // disagree with the session it describes. No settings gate: the org's feature flag already
  // decided whether a prompt exists at all, and `meetingNotifications` is scoped to call detection.
  yield* Effect.forkScoped(
    recordingBridge.stateChanges.pipe(
      Stream.map(state => state.autoPausePrompt),
      Stream.changesWith((a, b) => a?.deadlineMs === b?.deadlineMs && a?.graceMs === b?.graceMs),
      Stream.runForEach(prompt =>
        SubscriptionRef.update(cards, current =>
          mergeAutoPauseCard(current, prompt === null ? null : autoPauseCard(prompt, i18n.t))
        )
      )
    )
  );

  // SWEEPER — main-side expiry authority: tick 1s, drop lapsed TTLs (recording
  // any expired call-detected id so the producer can't re-card it). The ref
  // churn is deduped by the push fiber.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const dropped = yield* SubscriptionRef.modify(cards, current => {
        const kept = dropExpiredCards(current, now);
        return [current.filter(card => !kept.includes(card)), kept] as const;
      });
      const expiredDetection = dropped.find(card => card.kind === 'call-detected');
      if (expiredDetection !== undefined) {
        yield* Ref.set(expiredDetectionCardId, expiredDetection.id);
      }
    }).pipe(Effect.delay('1 second'), Effect.forever)
  );

  // FOLLOW THE DOCK — a dragEnd that lands the dock on another display
  // persists `dockDisplayId`; the notify window re-anchors to that display's
  // top-right corner (spec: the card layer follows the dock).
  yield* Effect.forkScoped(
    settings.settings.changes.pipe(
      Stream.map(current => current.dockDisplayId),
      Stream.changes,
      Stream.runForEach(() => windows.repositionNotifyWindow)
    )
  );

  // PUSH — fan the stack to the notify renderer, deduped by card identity and
  // re-parsed through the schema (an invalid stack is dropped loudly, never
  // sent). Same defect stance as the widget push fibers.
  yield* Effect.forkScoped(
    cards.changes.pipe(
      Stream.changesWith(sameCardStack),
      Stream.runForEach(stack => {
        const parsed = parseNotifyState({ locale: i18n.locale, cards: stack });
        const push = parsed.success
          ? windows.sendToNotifyWindow(NOTIFY_CHANNELS.stateStream, parsed.data).pipe(Effect.asVoid)
          : log.error('notify:state push dropped: stack failed the schema', { context: {
              issues: parsed.issues,
            } });
        return push.pipe(
          Effect.catchAllDefect(defect =>
            log.error('notify:state push failed — fiber continues', { error: defect })
          )
        );
      })
    )
  );

  yield* log.info('notify-window ipc handlers registered');
});
