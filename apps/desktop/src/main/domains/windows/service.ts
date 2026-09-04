import type { BrowserWindow } from 'electron';
import {
  Context,
  Data,
  type Effect,
  type Option,
  type Queue,
  type Scope,
  type SubscriptionRef,
} from 'effect';
import type { ThemeSource } from '@prismical/desktop-contracts';
import type { DockAnchor, DockDragSample } from './dock-geometry';
import type { WindowKind } from './policy';

export class WindowError extends Data.TaggedError('WindowError')<{
  readonly stage: string;
  readonly cause: unknown;
}> {}

/** Per-window identity record used by IPC sender validation. */
export interface WindowIdentity {
  readonly windowId: number;
  readonly webContentsId: number;
  readonly kind: WindowKind;
}

export type WindowEvent =
  | { readonly _tag: 'closed'; readonly windowId: number }
  | { readonly _tag: 'focused'; readonly windowId: number }
  | { readonly _tag: 'blurred'; readonly windowId: number };

export interface WindowRegistryService {
  /**
   * Scoped acquisition of the main window: secure webPreferences, deny-all
   * window-open handler, will-navigate confinement, event streams. The
   * finalizer removes listeners, drops the identity and destroys the window
   * if still live.
   */
  readonly openMainWindow: Effect.Effect<BrowserWindow, WindowError, Scope.Scope>;
  readonly identityForWebContents: (webContentsId: number) => Effect.Effect<Option.Option<WindowIdentity>>;
  readonly mainWindow: Effect.Effect<Option.Option<BrowserWindow>>;
  /** Show + focus the main window if it is still alive (tray/activate consumers). */
  readonly focusMainWindow: Effect.Effect<void>;
  /** Typed push to the main window renderer. False when no live window. */
  readonly sendToMainWindow: (channel: string, payload: unknown) => Effect.Effect<boolean>;
  /**
   * Point `nativeTheme.themeSource` at the renderer's in-app theme preference.
   * This domain already owns nativeTheme (the Windows titleBarOverlay re-skin
   * below), and the macOS vibrancy material reads the same appearance — so a
   * forced in-app theme has to be mirrored here or the frosted sidebar renders
   * in the OS's appearance instead of the app's.
   */
  readonly setThemeSource: (source: ThemeSource) => Effect.Effect<void>;
  /** closed/focus/blur events for every registered window. */
  readonly windowEvents: Queue.Dequeue<WindowEvent>;
  /**
   * Scoped acquisition of the floating recording widget: a frameless,
   * transparent, always-on-top, click-through panel pinned to the right edge.
   * Same secure defaults + navigation confinement as the main window, its own
   * widget preload. Boot-scoped (exists across sign-in/out) — the state stream
   * drives visibility, and it is click-through, so an idle transparent panel is
   * invisible + inert. The finalizer detaches listeners, drops the identity and
   * destroys the window.
   */
  readonly openWidgetWindow: Effect.Effect<BrowserWindow, WindowError, Scope.Scope>;
  /** The live widget window if one is registered and not destroyed. */
  readonly widgetWindow: Effect.Effect<Option.Option<BrowserWindow>>;
  /** Typed push to the widget renderer. False when no live widget window. */
  readonly sendToWidgetWindow: (channel: string, payload: unknown) => Effect.Effect<boolean>;
  /**
   * Toggle the widget window's click-through: `true` makes it ignore the mouse
   * (forwarding events under it), `false` makes it interactive. A no-op when no
   * widget window is live. The renderer drives this on hit-zone hover/leave.
   */
  readonly setWidgetIgnoreMouse: (ignore: boolean) => Effect.Effect<void>;
  /**
   * Scoped acquisition of the notification-card window: the
   * same sanitized always-on-top click-through panel shape as the widget,
   * pinned to the top-right of the dock's display. Boot-scoped; the card push
   * stream drives what renders — an empty stack is an invisible, inert panel.
   */
  readonly openNotifyWindow: Effect.Effect<BrowserWindow, WindowError, Scope.Scope>;
  /** The live notify window if one is registered and not destroyed. */
  readonly notifyWindow: Effect.Effect<Option.Option<BrowserWindow>>;
  /** Typed push to the notify renderer. False when no live notify window. */
  readonly sendToNotifyWindow: (channel: string, payload: unknown) => Effect.Effect<boolean>;
  /** Toggle the notify window's click-through (card hover), like the widget's. */
  readonly setNotifyIgnoreMouse: (ignore: boolean) => Effect.Effect<void>;
  /**
   * Re-resolve the notify window's bounds from the CURRENT settings (dock
   * display + vanish fallback) and setBounds the live window — the notify
   * layer follows the dock across displays (spec). A no-op when none is live.
   */
  readonly repositionNotifyWindow: Effect.Effect<void>;
  /**
   * Open the floating note window: a focusable, resizable
   * always-on-top window loading the MAIN renderer bundle at `#/float[/:id]`
   * with the MAIN preload (full membrane; sender kind 'float-note'). MANUAL
   * lifecycle (unlike the boot-scoped panels): created on demand, destroyed by
   * `closeFloatNoteWindow` or the OS; `onClosed` fires on EVERY close path so
   * the float coordinator can track liveness. Size/position seed from the
   * persisted per-display `floatNoteBounds` and persist back (debounced) on
   * move/resize. A no-op (focus only) when one is already live.
   */
  readonly openFloatNoteWindow: (options: {
    readonly noteId: string | null;
    /** Pre-encoded query string appended to the hash ('' or '?fresh=1&autostart=1'). */
    readonly search?: string;
    readonly onClosed: () => void;
  }) => Effect.Effect<void, WindowError>;
  /** The live float-note window if one exists and is not destroyed. */
  readonly floatNoteWindow: Effect.Effect<Option.Option<BrowserWindow>>;
  /** Destroy the live float-note window (its onClosed still fires). No-op when none. */
  readonly closeFloatNoteWindow: Effect.Effect<void>;
  /**
   * HIDE the live float-note window without destroying it — collapse keeps
   * the renderer alive (mounted React tree, live Yjs doc, warm queries) so
   * the next open is an instant show instead of a full reload. No-op when
   * none is live.
   */
  readonly hideFloatNoteWindow: Effect.Effect<void>;
  /** Typed push to the float-note renderer. False when none is live. */
  readonly sendToFloatNoteWindow: (channel: string, payload: unknown) => Effect.Effect<boolean>;
  /**
   * Fan a push out to every APP window (main + float-note) — the session /
   * recording / settings / updater push fibers ride this so the float renderer
   * stays a first-class app surface. Nav pushes stay targeted
   * (sendToMainWindow / sendToFloatNoteWindow) — a deep link must never yank
   * the float's route.
   */
  readonly sendToAppWindows: (channel: string, payload: unknown) => Effect.Effect<void>;
  /**
   * Apply a 2-axis drag sample to the live dock (widget) window: resolve the
   * display under the pointer (so a drag can cross displays),
   * project the sample through the pure `dragToDockAnchor` (band clamp + the
   * magnetic left/right edge snap), setBounds the window there, and return the
   * anchor + display id — the drag handlers persist both on release
   * (`dockAnchors[displayId]` + `dockDisplayId`). `None` when no widget is live.
   */
  readonly dragDockWindow: (
    sample: DockDragSample
  ) => Effect.Effect<Option.Option<{ readonly anchor: DockAnchor; readonly displayId: string }>>;
  /**
   * Re-seed the dock (widget) window's bounds from the CURRENT settings —
   * "reset dock position" clears `dockAnchors`/`dockDisplayId` and this
   * snaps the live pill back to the seeded spot. A no-op when none is live.
   */
  readonly repositionDockWindow: Effect.Effect<void>;
  /**
   * Re-seed the LIVE float-note window's bounds from the CURRENT settings —
   * the "reset dock position" write clears `floatNoteBounds` too, and the
   * settings row promises the floating note moves back as well. A no-op when
   * none is live.
   */
  readonly repositionFloatNoteWindow: Effect.Effect<void>;
  /**
   * Apply `setContentProtection` to every dock-family window (widget, notify,
   * float-note) — the "hide dock from screen sharing" setting. The float
   * shows real note content over every Space, so it MUST be included. New
   * windows self-apply at create from the current setting.
   */
  readonly setDockContentProtection: (enabled: boolean) => Effect.Effect<void>;
  /**
   * Reactive main-window focus signal: true while the main window is
   * focused. The widget push projection reads this to suppress the pill over the
   * focused main window (a pending detection bypasses it). Driven by the main
   * window's focus/blur callbacks.
   */
  readonly mainWindowFocused: SubscriptionRef.SubscriptionRef<boolean>;
}

export class WindowRegistry extends Context.Tag('desktop/WindowRegistry')<
  WindowRegistry,
  WindowRegistryService
>() {}
