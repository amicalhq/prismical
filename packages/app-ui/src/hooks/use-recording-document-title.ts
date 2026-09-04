"use client";

import * as React from "react";

/**
 * Reflect the recording session in the browser tab title.
 *
 * Web deliberately has no OS notification — no permission prompt, and if the user walked away
 * from the machine the screen is locked and a notification reaches nobody anyway. The tab title
 * is the zero-permission signal that DOES survive: it is visible on a backgrounded tab, in the
 * tab strip, and in window switchers.
 *
 * Two states, and the recording half is new — nothing in the app wrote `document.title` before
 * this, so "the tab tells you it's recording" simply didn't exist.
 *
 * Why an interval rather than a one-shot write: Next's app router re-applies the route's metadata
 * title on navigation, and a recording deliberately SURVIVES navigating off its note (the away
 * pill exists for exactly that). A single assignment would be silently clobbered by the next
 * route change, which is the most likely moment for the user to lose track of the session. So we
 * re-assert, cheaply, and restore whatever the route set once the session ends.
 */
const REASSERT_MS = 1000;

export function useRecordingDocumentTitle({
  active,
  paused,
  noteTitle,
}: {
  /** A session is live (including paused / stopping). */
  active: boolean;
  paused: boolean;
  noteTitle: string | null;
}): void {
  React.useEffect(() => {
    if (typeof document === "undefined" || !active) return;
    const label = paused ? "⏸ Paused" : "● Recording";
    const subject = noteTitle?.trim() ? ` · ${noteTitle.trim()}` : "";
    const desired = `${label}${subject}`;
    // The title to hand back on teardown. It is re-captured on every tick that finds someone
    // else's title in place, because a recording deliberately survives navigation: restoring the
    // title of the page the session STARTED on would leave the user reading "Standup" while
    // looking at Settings — and, since a pause re-runs this effect, that stale value would then
    // stick for the rest of the session.
    let routeTitle = document.title;
    const apply = () => {
      if (document.title === desired) return;
      routeTitle = document.title;
      document.title = desired;
    };
    apply();
    const id = setInterval(apply, REASSERT_MS);
    return () => {
      clearInterval(id);
      // Only give the title back if it is still ours; the route may legitimately have changed it.
      if (document.title === desired) document.title = routeTitle;
    };
  }, [active, paused, noteTitle]);
}
