'use client';

import * as React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// The single source of truth for product-level keyboard shortcuts.
//
// Every real binding registers here via `useShortcut` instead of owning its own
// `document.addEventListener("keydown", …)` with a hardcoded key, and the
// Settings → Shortcuts screen renders this same list — so what settings
// advertises is, by construction, what's actually bound. Sidebar hint chips
// (`shell/sidebar-nav.ts`) point at ids here too, rather than carrying their own
// "⌘ H" strings.
//
// Deliberately NOT in here: dialog/editor-level key handling (Escape to close,
// Enter to submit, the Ask @-mention menu). That's routine widget UX, not
// something a user would look up on a shortcuts screen.
//
// The desktop app's one OS-level global hotkey — the floating-note toggle — is
// NOT in this registry: it's a user-rebindable device setting owned by Electron
// main (`dockHotkey`, registered through globalShortcut), so it has no keydown
// binding to consolidate. The shortcuts screen still presents it in the same
// place, reading and writing device settings directly and formatting the
// accelerator with `acceleratorChips` below.
// ─────────────────────────────────────────────────────────────────────────────

export type ShortcutId = 'command-palette' | 'toggle-sidebar' | 'go-home' | 'go-settings';

export type ShortcutCategory = 'General' | 'Navigation';

export interface ShortcutDefinition {
  readonly id: ShortcutId;
  readonly category: ShortcutCategory;
  /**
   * `KeyboardEvent.key` for the non-modifier key — lowercase for letters. Every
   * shortcut also requires the platform "mod" key (⌘ on macOS, Ctrl elsewhere);
   * a modifier-less global binding would swallow ordinary typing.
   */
  readonly key: string;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /**
   * Only reliably bound in the desktop shell. Keyboard shortcuts are a
   * desktop-only feature — browsers reserve or override most
   * combos (⌘, opens browser prefs, macOS eats ⌘H) — so web ships ⌘K alone and
   * gates the rest off / hides their hint chips.
   */
  readonly desktopOnly: boolean;
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'command-palette',
    category: 'General',
    key: 'k',
    desktopOnly: false,
  },
  {
    id: 'toggle-sidebar',
    category: 'General',
    key: 'b',
    desktopOnly: true,
  },
  {
    id: 'go-home',
    category: 'Navigation',
    key: 'h',
    desktopOnly: true,
  },
  {
    id: 'go-settings',
    category: 'Navigation',
    key: ',',
    desktopOnly: true,
  },
];

const SHORTCUTS_BY_ID = new Map<ShortcutId, ShortcutDefinition>(
  SHORTCUTS.map(shortcut => [shortcut.id, shortcut])
);

export function getShortcut(id: ShortcutId): ShortcutDefinition {
  const shortcut = SHORTCUTS_BY_ID.get(id);
  if (!shortcut) throw new Error(`Unknown shortcut id: ${id}`);
  return shortcut;
}

// ─── Matching + dispatch ─────────────────────────────────────────────────────

// Which key counts as "mod" — ⌘ on Apple platforms, Ctrl everywhere else.
// Resolved lazily (never during a server render) and cached, since this runs on
// every keydown.
let applePlatform: boolean | null = null;
function isApplePlatform(): boolean {
  if (applePlatform === null) {
    applePlatform =
      typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }
  return applePlatform;
}

/**
 * Exact-chord match: the platform's mod key is required, and Shift/Alt must
 * match the definition rather than merely being tolerated (⌥⌘B is not ⌘B).
 *
 * This also un-shadows chords the old per-file listeners swallowed: they
 * ignored altKey, so on Windows/Linux AltGr (which sets ctrlKey AND altKey)
 * fired ⌘K/⌘B and ate the typed character.
 *
 * The mod test is deliberately exclusive rather than `metaKey || ctrlKey`.
 * Accepting either would silently claim a second chord that nothing in the UI
 * advertises — and on macOS that second chord is a system emacs binding (⌃K
 * kill-line, ⌃H backspace), while on Windows/Linux it's the Super/Windows key.
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
  const mod = isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return false;
  if (event.shiftKey !== (shortcut.shift ?? false)) return false;
  if (event.altKey !== (shortcut.alt ?? false)) return false;
  return event.key.toLowerCase() === shortcut.key;
}

type ShortcutHandler = () => void;

// One document listener for the whole app, installed with the first registration
// and removed with the last, so shortcuts don't accumulate listeners per mount.
const handlers = new Map<ShortcutId, Set<ShortcutHandler>>();
let listening = false;

function onKeyDown(event: KeyboardEvent): void {
  // Something closer to the user already handled this key. Most importantly the
  // note editor: ProseMirror/TipTap preventDefault()s the keys it binds (⌘B →
  // bold) but does NOT stop propagation, so the event still reaches document.
  // Without this check ⌘B would bold the selection AND collapse the sidebar.
  if (event.defaultPrevented) return;
  for (const shortcut of SHORTCUTS) {
    if (!matchesShortcut(event, shortcut)) continue;
    const registered = handlers.get(shortcut.id);
    // Nothing bound (e.g. ⌘B where the sidebar toggle is gated off): leave the
    // event alone so the platform default still applies, and keep scanning —
    // another entry could claim the same key with different modifiers.
    if (!registered || registered.size === 0) continue;
    event.preventDefault();
    for (const handler of [...registered]) handler();
    return;
  }
}

function registerShortcut(id: ShortcutId, handler: ShortcutHandler): () => void {
  let registered = handlers.get(id);
  if (!registered) {
    registered = new Set();
    handlers.set(id, registered);
  }
  registered.add(handler);
  if (!listening) {
    document.addEventListener('keydown', onKeyDown);
    listening = true;
  }

  return () => {
    registered.delete(handler);
    // Identity check, not just emptiness: if `id` were re-registered with a
    // fresh Set before this cleanup ran, dropping the entry would unbind the
    // live one.
    if (registered.size === 0 && handlers.get(id) === registered) {
      handlers.delete(id);
    }
    if (handlers.size === 0 && listening) {
      document.removeEventListener('keydown', onKeyDown);
      listening = false;
    }
  };
}

/**
 * Bind `handler` to the registry entry for `id`. Pass `enabled: false` to leave
 * the chord unbound (web gates off the desktop-only ones).
 */
export function useShortcut(
  id: ShortcutId,
  handler: ShortcutHandler,
  options?: { enabled?: boolean }
): void {
  const enabled = options?.enabled ?? true;
  // Keep the latest handler without re-registering on every render.
  const handlerRef = React.useRef(handler);
  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  React.useEffect(() => {
    if (!enabled) return;
    return registerShortcut(id, () => handlerRef.current());
  }, [id, enabled]);
}

// ─── Display ─────────────────────────────────────────────────────────────────

const APPLE_LABELS = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' } as const;
const OTHER_LABELS = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' } as const;

function labelsFor(isApple: boolean) {
  return isApple ? APPLE_LABELS : OTHER_LABELS;
}

function keyLabel(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Chips for one shortcut, in modifier order — e.g. `["⌘", "K"]`. Join with `" "`
 * for the settings rows / sidebar hints, `""` for the compact ⌘K trigger chip.
 */
export function shortcutChips(shortcut: ShortcutDefinition, isApple = true): string[] {
  const labels = labelsFor(isApple);
  return [
    labels.mod,
    ...(shortcut.alt ? [labels.alt] : []),
    ...(shortcut.shift ? [labels.shift] : []),
    keyLabel(shortcut.key),
  ];
}

const ACCELERATOR_MODIFIERS: Readonly<Record<string, keyof typeof APPLE_LABELS>> = {
  Command: 'mod',
  Cmd: 'mod',
  CommandOrControl: 'mod',
  CmdOrCtrl: 'mod',
  Super: 'mod',
  Meta: 'mod',
  Control: 'ctrl',
  Ctrl: 'ctrl',
  Alt: 'alt',
  Option: 'alt',
  Shift: 'shift',
};

/**
 * Chips for an Electron accelerator string (`"Alt+Shift+N"`), used for the
 * desktop global hotkey that main owns rather than this registry.
 */
export function acceleratorChips(accelerator: string, isApple = true): string[] {
  const labels = labelsFor(isApple);
  return accelerator.split('+').map(part => {
    const modifier = ACCELERATOR_MODIFIERS[part];
    return modifier ? labels[modifier] : keyLabel(part);
  });
}

/**
 * Whether to render mac glyphs (⌘/⌥/⇧) or spelled-out modifiers. Starts at
 * `true` so the server render and the first client render agree — Next SSRs the
 * web shell — then corrects itself after mount on Windows/Linux.
 */
export function useIsApplePlatform(): boolean {
  const [isApple, setIsApple] = React.useState(true);
  React.useEffect(() => {
    setIsApple(/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent));
  }, []);
  return isApple;
}

/**
 * Whether the platform's mod key (⌘ on Apple, Ctrl elsewhere) is held right
 * now — the reveal signal for the sidebar/search hint chips, which stay hidden
 * until you reach for the modifier.
 *
 * Reads the modifier off every keydown/keyup rather than tracking `event.key`
 * transitions: macOS suppresses keyup for other keys while ⌘ is down, so a
 * key-name state machine desyncs the moment you press ⌘K. The modifier flags
 * on whatever event does arrive are always current.
 *
 * Blur/visibility reset matters as much as the listeners: ⌘Tab moves focus
 * away mid-chord and the keyup lands in the other app, so without this the
 * chips would stay stuck open until the next stray key.
 */
export function useIsModHeld(): boolean {
  const [held, setHeld] = React.useState(false);

  React.useEffect(() => {
    const sync = (event: KeyboardEvent): void => {
      setHeld(isApplePlatform() ? event.metaKey : event.ctrlKey);
    };
    const clear = (): void => setHeld(false);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  return held;
}
