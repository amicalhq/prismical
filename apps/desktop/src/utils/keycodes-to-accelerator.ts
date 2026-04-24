import { getKeyFromKeycode } from "./keycode-map";

// Map our stored key names to Electron Accelerator modifier names.
// Left/right variants collapse into the same modifier since Electron
// accelerators don't distinguish them.
const MODIFIER_TO_ACCELERATOR: Record<string, string> = {
  Cmd: "Command",
  RCmd: "Command",
  Ctrl: "Control",
  RCtrl: "Control",
  Alt: "Alt",
  RAlt: "Alt",
  Shift: "Shift",
  RShift: "Shift",
  Win: "Super",
  RWin: "Super",
};

// Keys whose stored name differs from the Electron Accelerator spelling.
const KEY_TO_ACCELERATOR: Record<string, string> = {
  Enter: "Return",
};

/**
 * Convert a stored keycode array (see app-settings shortcuts) into an
 * Electron globalShortcut Accelerator string, e.g. [CMD, SHIFT, P] → "Command+Shift+P".
 *
 * Returns null when the combo can't be represented as an Electron
 * accelerator (no non-modifier key, more than one, or contains Fn which
 * globalShortcut doesn't support).
 */
export function keycodesToAccelerator(keycodes: number[]): string | null {
  const modifiers: string[] = [];
  const keys: string[] = [];

  for (const keycode of keycodes) {
    const name = getKeyFromKeycode(keycode);
    if (!name) return null;

    const modifierName = MODIFIER_TO_ACCELERATOR[name];
    if (modifierName) {
      if (!modifiers.includes(modifierName)) modifiers.push(modifierName);
      continue;
    }

    if (name === "Fn") return null;

    keys.push(KEY_TO_ACCELERATOR[name] ?? name);
  }

  if (keys.length !== 1) return null;

  return [...modifiers, ...keys].join("+");
}
