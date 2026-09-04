// Resilient clipboard copy shared by every "copy" affordance in the app-ui
// (share links, API keys, signing secrets, transcripts, note markdown).
//
// The async `navigator.clipboard.writeText` is preferred, but it is not
// reliable enough to use on its own: on Chromium it rejects with
// `NotAllowedError: Document is not focused` whenever the tab lacks OS focus
// (DevTools focused, focus-managed overlays) and it is generally flaky inside
// portal/modal contexts — which is exactly how the note "public link" copy was
// failing. When the async API is missing or rejects we fall back
// to a synchronous `document.execCommand("copy")`.
//
// The fallback drives the copy off a Selection-API range over an off-screen
// <span> rather than focusing a hidden <textarea>. That distinction matters
// inside a Radix Dialog: focusing an element outside the dialog trips Radix's
// focus trap, which yanks focus (and the textarea's selection) back before the
// copy runs. Selecting a range never moves DOM focus, so it survives the trap.

/**
 * Copy `text` to the clipboard. Returns `true` when it lands, `false` when
 * every strategy failed (caller decides how to surface success/failure).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Async API unavailable or rejected — fall through to execCommand below.
      // On Chromium/Electron (our target) a rejected writeText settles in
      // milliseconds and keeps the frame's transient activation, so the fallback
      // still copies. WebKit drops the gesture across the await, but Safari's
      // writeText rarely rejects, so its primary path is what runs there.
    }
  }
  // Callers treat `false` as "copy failed"; never let a synchronous DOM failure
  // in the fallback turn into an unhandled promise rejection.
  try {
    return legacyCopy(text);
  } catch {
    return false;
  }
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const selection = document.getSelection();
  if (!selection) return false;

  const span = document.createElement("span");
  span.textContent = text;
  // Preserve newlines/whitespace; keep the node out of view and out of flow.
  span.style.whiteSpace = "pre";
  span.style.position = "fixed";
  span.style.top = "0";
  span.style.left = "0";
  span.style.opacity = "0";
  span.style.pointerEvents = "none";
  span.setAttribute("aria-hidden", "true");
  document.body.appendChild(span);

  // Remember whatever the user had selected so a background copy doesn't clobber it.
  const saved: Range[] = [];
  for (let i = 0; i < selection.rangeCount; i++) saved.push(selection.getRangeAt(i));

  const range = document.createRange();
  range.selectNodeContents(span);
  selection.removeAllRanges();
  selection.addRange(range);

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  selection.removeAllRanges();
  for (const r of saved) selection.addRange(r);
  span.remove();
  return ok;
}
