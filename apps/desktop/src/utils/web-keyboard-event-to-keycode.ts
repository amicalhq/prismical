import { getKeycodeFromKeyName } from "./keycode-map";
import { isWindows } from "./platform";

// Map KeyboardEvent.code values to the app's internal key names.
// The app stores native-platform keycodes (mac / windows), so we translate
// through the same key-name layer the native helpers use.
const CODE_TO_KEY_NAME_SHARED: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Escape",
  CapsLock: "CapsLock",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

// Modifier / "Backspace" / "Delete" naming differs between the mac and
// windows keycode tables.
const CODE_TO_KEY_NAME_MAC: Record<string, string> = {
  MetaLeft: "Cmd",
  MetaRight: "RCmd",
  ControlLeft: "Ctrl",
  ControlRight: "RCtrl",
  AltLeft: "Alt",
  AltRight: "RAlt",
  ShiftLeft: "Shift",
  ShiftRight: "RShift",
  Backspace: "Delete",
  Delete: "ForwardDelete",
};

const CODE_TO_KEY_NAME_WIN: Record<string, string> = {
  MetaLeft: "Win",
  MetaRight: "RWin",
  ControlLeft: "Ctrl",
  ControlRight: "RCtrl",
  AltLeft: "Alt",
  AltRight: "RAlt",
  ShiftLeft: "Shift",
  ShiftRight: "RShift",
  Backspace: "Backspace",
  Delete: "Delete",
};

function codeToKeyName(code: string): string | undefined {
  const platformMap = isWindows()
    ? CODE_TO_KEY_NAME_WIN
    : CODE_TO_KEY_NAME_MAC;
  if (platformMap[code]) return platformMap[code];
  if (CODE_TO_KEY_NAME_SHARED[code]) return CODE_TO_KEY_NAME_SHARED[code];

  // KeyA..KeyZ → A..Z
  if (code.length === 4 && code.startsWith("Key")) {
    return code.slice(3);
  }
  // Digit0..Digit9 → 0..9
  if (code.length === 6 && code.startsWith("Digit")) {
    return code.slice(5);
  }
  // F1..F20
  if (/^F\d{1,2}$/.test(code)) {
    return code;
  }
  return undefined;
}

/**
 * Convert a browser KeyboardEvent into the platform-native keycode used
 * by the rest of the shortcut system. Returns `undefined` when the key
 * isn't one we can represent (e.g. dead keys, IME composition).
 */
export function webKeyboardEventToKeycode(
  event: KeyboardEvent,
): number | undefined {
  const name = codeToKeyName(event.code);
  if (!name) return undefined;
  return getKeycodeFromKeyName(name);
}
