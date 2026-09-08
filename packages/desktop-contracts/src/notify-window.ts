import type { DesktopLoggingApi } from './main-window';
/**
 * Notify-window IPC contract — the dock's separated notification card layer:
 * a top-anchored click-through
 * panel rendering a small stack of meeting/call cards, structurally the same
 * sanitized membrane as the widget window: no env, no auth, no transport
 * — one state snapshot/stream, one action verb, one interactivity toggle; `.strip()` on
 * every push so an unlisted key never crosses).
 *
 * Three card KINDS ship now; only `call-detected` has a live producer (the
 * detection domain). `upcoming-meeting` (desktop calendar) and `auto-pause`
 * (silence detection) are schema seams their
 * producers fill later — the renderer already knows how to draw all three.
 */
import { z } from 'zod';
import {
  applicationLocaleSchema,
  toParseResult,
  type ParseResult,
  type MainWindowTelemetryApi,
} from './main-window';

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const NOTIFY_CHANNELS = {
  /** invoke → NotifyStateView: guaranteed initial snapshot after preload attaches. */
  stateGet: 'notify:state:get',
  /** push main→notify: the current card stack (max 3, newest first). */
  stateStream: 'notify:state',
  /** invoke(NotifyAction) → void: a card button press OR a card-body dismiss. */
  action: 'notify:action',
  /** invoke(NotifySetInteractive) → void: click-through toggle on card hover. */
  setInteractive: 'notify:setInteractive',
} as const;

// ---------------------------------------------------------------------------
// notify:state (main→notify push)
// ---------------------------------------------------------------------------

/** A card action button (rendered right-aligned; `primary` = filled accent). */
export const notifyCardActionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    primary: z.boolean(),
  })
  .strip();
export type NotifyCardAction = z.infer<typeof notifyCardActionSchema>;

/**
 * One notification card — the uniform 336px slim row (identity left → 2-line
 * content → actions right, 2px bottom progress loader). `expiresAtMs` +
 * `durationMs` drive the loader renderer-side (no per-tick pushes): the bar
 * runs from `expiresAtMs - durationMs` to `expiresAtMs`; null = no auto
 * behavior (no loader). `accent: 'amber'` is the auto-pause treatment (amber
 * bar + loader-as-countdown).
 */
export const notifyCardSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['call-detected', 'upcoming-meeting', 'auto-pause']),
    title: z.string(),
    subtitle: z.string(),
    /** Identity badge source (call-detected: the app's display name). */
    appName: z.string().nullable(),
    /** Upcoming-meeting inset bar — the calendar's OWN color (css color). */
    calendarColor: z.string().nullable(),
    /** Upcoming-meeting platform glyph derivation (zoom/meet/teams by host). */
    joinUrl: z.string().nullable(),
    expiresAtMs: z.number().finite().nullable(),
    durationMs: z.number().finite().nullable(),
    accent: z.enum(['default', 'amber']),
    actions: z.array(notifyCardActionSchema).max(3),
  })
  .strip();
export type NotifyCard = z.infer<typeof notifyCardSchema>;

export const notifyStateSchema = z
  .object({
    /** Immutable startup locale; lets this restricted renderer initialize i18n. */
    locale: applicationLocaleSchema,
    cards: z.array(notifyCardSchema).max(3),
  })
  .strip();
export type NotifyStateView = z.infer<typeof notifyStateSchema>;

// ---------------------------------------------------------------------------
// notify:action / notify:setInteractive (invoke)
// ---------------------------------------------------------------------------

/**
 * A card interaction: `actionId` is one of the card's action ids, or the
 * reserved `'dismiss'` (a click on the card body outside any button — there is
 * no ✕). `.strict()` — no other key.
 */
export const notifyActionSchema = z.object({ cardId: z.string(), actionId: z.string() }).strict();
export type NotifyAction = z.infer<typeof notifyActionSchema>;

export const notifySetInteractiveSchema = z.object({ interactive: z.boolean() }).strict();
export type NotifySetInteractive = z.infer<typeof notifySetInteractiveSchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export const parseNotifyState = (value: unknown): ParseResult<NotifyStateView> =>
  toParseResult(notifyStateSchema.safeParse(value));

export const parseNotifyAction = (value: unknown): ParseResult<NotifyAction> =>
  toParseResult(notifyActionSchema.safeParse(value));

export const parseNotifySetInteractive = (value: unknown): ParseResult<NotifySetInteractive> =>
  toParseResult(notifySetInteractiveSchema.safeParse(value));

// ---------------------------------------------------------------------------
// The preload surface (typed contract for window.notify in the notify window)
// ---------------------------------------------------------------------------

export interface NotifyDesktopApi {
  /** Pull the current snapshot so initial paint never depends on an early push winning a race. */
  readonly logging: DesktopLoggingApi;
  readonly telemetry: Pick<MainWindowTelemetryApi, 'getState' | 'onChanged' | 'captureException'>;
  readonly getState: () => Promise<NotifyStateView>;
  /** Subscribe to the pushed card stack (latest replays to a late subscriber). */
  readonly onState: (listener: (state: NotifyStateView) => void) => () => void;
  /** Fire a card action ('dismiss' for a card-body click). */
  readonly action: (cardId: string, actionId: string) => void;
  /** Toggle window click-through: true while a card is hovered, false on leave. */
  readonly setInteractive: (interactive: boolean) => void;
}
