/**
 * Notification-card policy — PURE builders for the card stack
 * the notify window renders. No clock reads, no side effects: callers pass
 * `nowMs`, so the card math is exhaustively unit-testable (notify-policy.test.ts).
 *
 * Meeting detection produces the `call-detected` card (this replaced the
 * old detection PILL — same "Take Notes" affordance, same dismiss-with-cooldown
 * semantics, now with a 12s auto-dismiss loader). A second
 * producer: the recording domain's silence watcher → the `auto-pause` card. The
 * `upcoming-meeting` kind is still schema-only (desktop calendar fills it in).
 */
import type { NotifyCard } from '@prismical/desktop-contracts';
import type { ApplicationTFunction } from '@prismical/app-i18n';
import type { DetectedMeeting } from './policy';

/** How long a call-detected card lingers before auto-dismissing (the loader span). */
export const DETECTION_CARD_DURATION_MS = 12_000;

/** Max cards the stack renders (newest first — the schema pins this too). */
export const MAX_NOTIFY_CARDS = 3;

/**
 * Card identity for a detection: bundle + detection timestamp, so a NEW
 * detection of the same app (left + rejoined a call) gets a fresh card + TTL
 * while repeated state emissions of the SAME detection never reset the loader.
 */
export const detectionCardId = (detection: DetectedMeeting): string =>
  `call:${detection.bundleId}:${detection.detectedAt}`;

/** The call-detected card: app badge, mic attribution line, [Take Notes]. */
export const callDetectedCard = (
  detection: DetectedMeeting,
  nowMs: number,
  t: ApplicationTFunction
): NotifyCard => ({
  id: detectionCardId(detection),
  kind: 'call-detected',
  title: t('desktop.notify.meetingDetected'),
  subtitle: t('desktop.notify.microphoneInUse', { appName: detection.displayName }),
  appName: detection.displayName,
  calendarColor: null,
  joinUrl: null,
  expiresAtMs: nowMs + DETECTION_CARD_DURATION_MS,
  durationMs: DETECTION_CARD_DURATION_MS,
  accent: 'default',
  actions: [{ id: 'take-notes', label: t('desktop.notify.takeNotes'), primary: true }],
});

/**
 * Merge the current detection into a card stack: keeps the existing card (its
 * original TTL) when the same detection is already carded, swaps in the fresh
 * card otherwise, drops the call-detected card when nothing is detected or the
 * layer is disabled. Non-detection cards ride along untouched, newest first,
 * capped at MAX_NOTIFY_CARDS.
 */
export const mergeDetectionCard = (
  cards: readonly NotifyCard[],
  active: NotifyCard | null
): readonly NotifyCard[] => {
  const others = cards.filter(card => card.kind !== 'call-detected');
  if (active === null) return others;
  const existing = cards.find(card => card.id === active.id);
  return [existing ?? active, ...others].slice(0, MAX_NOTIFY_CARDS);
};

/**
 * Drop every card whose TTL has lapsed (the sweeper's pure half).
 *
 * `auto-pause` is exempt: its bar is a countdown to the recording PAUSING, not to the
 * card dismissing, and the pause commits off the AUDIO clock — which drifts from wall time when
 * frames stall and stops entirely if capture does. Sweeping on `expiresAtMs` would therefore yank
 * the card a moment before (or, if frames stalled, long before) the thing it is announcing
 * actually happens. Its removal is driven by the recording state instead, which is the only thing
 * that knows.
 */
export const dropExpiredCards = (
  cards: readonly NotifyCard[],
  nowMs: number
): readonly NotifyCard[] =>
  cards.filter(
    card => card.kind === 'auto-pause' || card.expiresAtMs === null || card.expiresAtMs > nowMs
  );

/**
 * Display-equality for push dedupe. Structural (JSON), not id-only: today's
 * cards are immutable per id, but the auto-pause seam is likely
 * to mutate a live card (countdown extension) — an id-only compare would
 * silently swallow that push. Stacks are ≤3 tiny objects; JSON is fine.
 */
export const sameCardStack = (a: readonly NotifyCard[], b: readonly NotifyCard[]): boolean =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Auto-pause on silence
// ---------------------------------------------------------------------------

/** Card actions for the auto-pause prompt. `dismiss` (card-body click) means keep-recording. */
export const AUTO_PAUSE_KEEP = 'keep-recording';
export const AUTO_PAUSE_PAUSE = 'pause';

/**
 * One card per prompt: the id carries the deadline so a re-raised prompt (a later silent stretch
 * in the same session) is a NEW card with a fresh loader, while repeated emissions of the same
 * prompt keep theirs.
 */
export const autoPauseCardId = (deadlineMs: number): string => `auto-pause:${deadlineMs}`;

/**
 * The "Still there?" card. Unlike `call-detected`, its loader is not a dismissal countdown — it
 * runs down to the moment the recording PAUSES, which is why `accent: 'amber'` exists. The card is
 * never swept on expiry either: the sweeper drops lapsed TTLs, and the pause itself is what
 * retracts this one, so `expiresAtMs` is purely the loader's end point.
 */
export const autoPauseCard = (
  prompt: { graceMs: number; deadlineMs: number },
  t: ApplicationTFunction
): NotifyCard => ({
  id: autoPauseCardId(prompt.deadlineMs),
  kind: 'auto-pause',
  title: t('desktop.notify.stillThere'),
  subtitle: t('desktop.notify.silencePause'),
  appName: null,
  calendarColor: null,
  joinUrl: null,
  expiresAtMs: prompt.deadlineMs,
  durationMs: prompt.graceMs,
  accent: 'amber',
  actions: [
    { id: AUTO_PAUSE_KEEP, label: t('desktop.notify.keepRecording'), primary: true },
    { id: AUTO_PAUSE_PAUSE, label: t('desktop.notify.pause'), primary: false },
  ],
});

/**
 * Merge the current auto-pause prompt into the stack, mirroring `mergeDetectionCard`. Keeping the
 * existing card when the id matches preserves its loader across repeated state pushes.
 */
export const mergeAutoPauseCard = (
  cards: readonly NotifyCard[],
  active: NotifyCard | null
): readonly NotifyCard[] => {
  const others = cards.filter(card => card.kind !== 'auto-pause');
  if (active === null) return others;
  const existing = cards.find(card => card.id === active.id);
  // Newest first, and the prompt outranks a detection card: it is asking about the recording the
  // user already has running.
  return [existing ?? active, ...others].slice(0, MAX_NOTIFY_CARDS);
};
