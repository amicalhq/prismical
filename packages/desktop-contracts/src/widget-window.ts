/**
 * Widget-window IPC contract.
 *
 * The floating recording widget gets its own preload with EXACTLY this surface
 * and nothing else: the widget preload cannot query notes, accounts,
 * settings, or tokens — one state snapshot/stream plus command verbs, that's all;
 * the drag verbs carry geometry, never a token.
 *
 * The single main→widget push (widget:state) carries the sanitized projection
 * the pill renders: whether it is visible, which of the three pills to show, and
 * the minimal detection/recording fields those pills need. Like the recording
 * state view it is structurally token-free — `.strip()` drops any unlisted key
 * (belt-and-braces) rather than crossing the membrane.
 */
import { z } from 'zod';
import { applicationLocaleSchema, toParseResult, type ParseResult, type MainWindowTelemetryApi } from './main-window';

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const WIDGET_CHANNELS = {
  /** invoke → WidgetStateView: guaranteed initial snapshot after preload attaches. */
  stateGet: 'widget:state:get',
  /** push main→widget: the projected widget state (visible + pill + fields). */
  stateStream: 'widget:state',
  /**
   * push main→widget: the live capture level — ~12 Hz smoothed
   * 0..1 RMS, emitted only while recording AND the pill is visible. Ephemeral
   * (no replay buffer): a missed push just means the next one drives the bars;
   * the renderer falls back to its synthetic pulse while none arrive.
   */
  levelStream: 'widget:level',
  /** invoke(SetInteractiveRequest) → void: toggle window click-through on hover. */
  setInteractive: 'widget:setInteractive',
  /** invoke → void: start a dual-capture recording (the pill's "Take Notes"). */
  startRecording: 'widget:startRecording',
  /** invoke → void: stop the active recording (the pill's "Stop"). */
  stopRecording: 'widget:stopRecording',
  /** invoke → void: pause the active recording (`canPause` gates the UI). */
  pauseRecording: 'widget:pauseRecording',
  /** invoke → void: resume the paused recording (`canPause` gates the UI). */
  resumeRecording: 'widget:resumeRecording',
  /** invoke → void: focus the main window (the pill's "Open note"). */
  openMain: 'widget:openMain',
  /** invoke → void: open the floating note on the slot (the pill's 📓). */
  expandNote: 'widget:expandNote',
  /** invoke(WidgetDrag) → void: live reposition mid-drag (NOT persisted). */
  dragMove: 'widget:dragMove',
  /** invoke(WidgetDrag) → void: final reposition on release (persisted). */
  dragEnd: 'widget:dragEnd',
} as const;

// ---------------------------------------------------------------------------
// widget:state (main→widget push)
// ---------------------------------------------------------------------------

/**
 * The projected widget state. `visible` gates the whole pill (focus-aware: hidden
 * while the main window is focused, unless a meeting is detected). `mode` selects
 * the pill; `detection`/`recording` carry the minimal fields that pill renders and
 * are null otherwise. `.strip()` at every level keeps the surface sanitized — an
 * unlisted (e.g. token-shaped) key is dropped, never forwarded — mirroring the
 * recording state view's belt-and-braces stance.
 */
export const widgetStateSchema = z
  .object({
    /** Immutable startup locale; lets this restricted renderer initialize i18n. */
    locale: applicationLocaleSchema,
    visible: z.boolean(),
    // A meeting detection is a notification
    // CARD (notify-window.ts) now, never a pill — the pill is idle or recording,
    // and the visibility rule lost its detection-bypasses-focus special case.
    mode: z.enum(['idle', 'recording']),
    recording: z
      .object({
        // 'paused' is emitted while native capture stays alive but discards
        // frames until the recording is resumed.
        status: z.enum(['starting', 'recording', 'paused', 'stopping', 'error']),
        micOnly: z.boolean(),
        /** Pause/resume renders only when the domain reports the capability. */
        canPause: z.boolean(),
        /**
         * Recording start (epoch ms) — the renderer derives the elapsed timer as
         * `now - startedAt - pausedAccumMs` locally, so the state push never
         * churns per second. Null while `starting` has not stamped it yet.
         */
        startedAt: z.number().finite().nullable(),
        /** Total paused time so far (ms); grows across pauses. */
        pausedAccumMs: z.number().finite(),
        /** Accepted-sample media duration at `elapsedAt`. */
        elapsedMs: z.number().finite(),
        /** Epoch ms for the duration sample; null when no local ticking is valid. */
        elapsedAt: z.number().finite().nullable(),
      })
      .strip()
      .nullable(),
  })
  .strip();
export type WidgetStateView = z.infer<typeof widgetStateSchema>;

/**
 * The widget:level payload: a smoothed 0..1 capture RMS.
 * `.strip()` like the state push — belt-and-braces on every main→widget lane.
 */
export const widgetLevelSchema = z.object({ level: z.number().finite() }).strip();
export type WidgetLevel = z.infer<typeof widgetLevelSchema>;

// ---------------------------------------------------------------------------
// widget:setInteractive (invoke)
// ---------------------------------------------------------------------------

/**
 * Toggle the click-through window's interactivity: the renderer sets `true` while
 * the pointer is over a hit-zone and `false` on leave, so the transparent panel
 * only intercepts clicks while the pill is hovered. `.strict()` — no other key.
 */
export const setInteractiveRequestSchema = z.object({ interactive: z.boolean() }).strict();
export type SetInteractiveRequest = z.infer<typeof setInteractiveRequestSchema>;

// ---------------------------------------------------------------------------
// widget:dragMove / widget:dragEnd (invoke) — drag-to-reposition
// ---------------------------------------------------------------------------

/**
 * A 2-axis drag sample for free drag on both axes: the pointer's
 * absolute screen position (`screenX`/`screenY`) and the grab point's offset
 * from the widget window's origin (`pointerOffsetX`/`pointerOffsetY`), so main
 * derives the window's new origin as `screen - pointerOffset` per axis. Both
 * verbs carry the same shape; `.strict()` — no other key. Main clamps the
 * derived position into the pointer's display work-area bands and applies the
 * magnetic left/right edge snap (dock-geometry.ts).
 */
export const widgetDragSchema = z
  .object({
    // .finite() — this is the one renderer-CONTROLLED numeric surface; an
    // Infinity sample must die at the membrane, not reach the geometry math.
    screenX: z.number().finite(),
    screenY: z.number().finite(),
    pointerOffsetX: z.number().finite(),
    pointerOffsetY: z.number().finite(),
  })
  .strict();
export type WidgetDrag = z.infer<typeof widgetDragSchema>;

// ---------------------------------------------------------------------------
// Parse helpers (share the main-window ParseResult shape)
// ---------------------------------------------------------------------------

export const parseWidgetState = (value: unknown): ParseResult<WidgetStateView> =>
  toParseResult(widgetStateSchema.safeParse(value));

export const parseWidgetLevel = (value: unknown): ParseResult<WidgetLevel> =>
  toParseResult(widgetLevelSchema.safeParse(value));

export const parseSetInteractiveRequest = (value: unknown): ParseResult<SetInteractiveRequest> =>
  toParseResult(setInteractiveRequestSchema.safeParse(value));

export const parseWidgetDrag = (value: unknown): ParseResult<WidgetDrag> =>
  toParseResult(widgetDragSchema.safeParse(value));

// ---------------------------------------------------------------------------
// The preload surface (typed contract for window.widget in the widget window)
// ---------------------------------------------------------------------------

/**
 * The widget window's full capability surface: one sanitized state pull,
 * its live stream, and fire-and-forget command verbs. No env, no auth, no
 * transport, no e2e — a dumb view that renders snapshots and emits intents.
 */
export interface WidgetDesktopApi {
  /** Pull the current snapshot so initial paint never depends on an early push winning a race. */
  readonly telemetry: Pick<MainWindowTelemetryApi, 'getState' | 'onChanged' | 'captureException'>;
  readonly getState: () => Promise<WidgetStateView>;
  /** Subscribe to the pushed widget state (latest replays to a late subscriber). */
  readonly onState: (listener: (state: WidgetStateView) => void) => () => void;
  /**
   * Subscribe to the ~12 Hz capture level (0..1). Ephemeral — nothing replays;
   * the renderer holds its synthetic pulse until pushes arrive.
   */
  readonly onLevel: (listener: (level: number) => void) => () => void;
  /** Toggle window click-through: true while a hit-zone is hovered, false on leave. */
  readonly setInteractive: (interactive: boolean) => void;
  /** Start a dual-capture recording (idle/detection "Take Notes"). */
  readonly startRecording: () => void;
  /** Stop the active recording (recording pill "Stop"). */
  readonly stopRecording: () => void;
  /** Pause the active recording (`canPause`-gated). */
  readonly pauseRecording: () => void;
  /** Resume the paused recording (`canPause`-gated). */
  readonly resumeRecording: () => void;
  /** Focus the main window (recording pill "Open note"). */
  readonly openMain: () => void;
  /** Open the floating note on the slot (the 📓 button). */
  readonly expandNote: () => void;
  /** Live 2-axis reposition mid-drag (high-frequency, NOT persisted). */
  readonly dragMove: (
    screenX: number,
    screenY: number,
    pointerOffsetX: number,
    pointerOffsetY: number
  ) => void;
  /** Final 2-axis reposition on pointer release (persisted per display). */
  readonly dragEnd: (
    screenX: number,
    screenY: number,
    pointerOffsetX: number,
    pointerOffsetY: number
  ) => void;
}
