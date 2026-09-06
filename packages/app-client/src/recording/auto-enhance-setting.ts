"use client";

import * as React from "react";

// Per-device preference: after a recording is stopped, auto-run Enhance on it (scoped to
// that recording) and stage the result as a diff for the user to accept. Default ON. Stored in
// localStorage — this is a UX preference, not account data, so per-device is fine and it needs no
// server round-trip. The web Settings > Preferences toggle and the recording dock both read it.

const KEY = "prismical:auto-enhance";

/** Imperative read (used by the dock's Stop handler). SSR-safe; defaults ON. */
export function getAutoEnhanceEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

/** Persist + notify same-tab listeners (the native `storage` event only fires cross-tab). */
export function setAutoEnhanceEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, on ? "1" : "0");
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
}

/** Reactive hook for the Settings toggle. Starts at the ON default and syncs on mount to avoid an
 * SSR/client hydration mismatch. */
export function useAutoEnhanceEnabled(): [boolean, (on: boolean) => void] {
  const [on, setOn] = React.useState(true);

  React.useEffect(() => {
    setOn(getAutoEnhanceEnabled());
    const sync = (e: StorageEvent) => {
      if (e.key === null || e.key === KEY) setOn(getAutoEnhanceEnabled());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const set = React.useCallback((next: boolean) => {
    setAutoEnhanceEnabled(next);
    setOn(next);
  }, []);

  return [on, set];
}
