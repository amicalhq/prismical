"use client";

import * as React from "react";

/**
 * Width-FLIP wrapper for dock slots whose content swaps between
 * different-width pills (skill sparkle ↔ diff bar; "New note" ↔ recording
 * cluster). Without it a swap resizes the centered dock row in ONE frame —
 * every neighbouring pill yanks sideways ±half the delta (the diff bar alone
 * is a ±91px jump). On a `contentKey` change it animates from the old width to
 * the new content's natural width, then returns to `width: auto`.
 *
 * The swap is detected by KEY, not by observing width deltas: a delta
 * heuristic can't tell a content swap from a busy-main-thread frame skip of a
 * child's own width animation (the recording pill's 78↔112/148 morph), and chasing
 * that morph with a lagging transition + overflow clip shaved the pill's
 * ring/shadow every frame — a visible border flicker on record start/stop.
 * At rest the wrapper is `width: auto` with no clipping, so children animate
 * themselves freely; only during the 200ms swap slide does it clip, with
 * `overflow-clip-margin` headroom so ring + drop shadow survive (Safari lacks
 * clip-margin and hard-clips the shadow for those 200ms — acceptable).
 *
 * Measurements use offsetWidth (layout truth), never getBoundingClientRect —
 * gBCR bakes in transforms, so a hover scale on the wrapper or an ancestor
 * would poison the recorded width and the FLIP would slide from a wrong start.
 */
export function AnimatedWidth({
  contentKey,
  children,
}: {
  /** Identity of the rendered content. Change it exactly when the slot swaps
   * to different content whose width jump should be animated. */
  contentKey: string;
  children: React.ReactNode;
}) {
  const outerRef = React.useRef<HTMLDivElement>(null);
  const lastWidthRef = React.useRef<number | null>(null);
  const slidingRef = React.useRef(false);

  const release = React.useCallback(() => {
    const outer = outerRef.current;
    if (!outer) return;
    slidingRef.current = false;
    outer.style.width = "";
    outer.style.overflow = "";
    outer.style.overflowClipMargin = "";
  }, []);

  // Track the at-rest (and mid-slide, for interrupted swaps) width. The observer
  // also RETARGETS an in-flight slide when the content itself resizes mid-pin
  // (e.g. the skills query landing during a page-morph slide): updating the
  // pinned width mid-transition retargets it smoothly instead of letting the
  // slide finish at a stale width and snap on release.
  React.useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    lastWidthRef.current = outer.offsetWidth;
    const ro = new ResizeObserver(() => {
      lastWidthRef.current = outer.offsetWidth;
      if (slidingRef.current) {
        const inner = outer.firstElementChild as HTMLElement | null;
        if (inner && Math.abs(inner.offsetWidth - parseFloat(outer.style.width || "0")) >= 1) {
          outer.style.width = `${inner.offsetWidth}px`;
        }
      }
    });
    // Observe the CONTENT: the outer's own width is pinned during a slide, so it
    // wouldn't report the mid-pin content resize the retarget above needs.
    const inner = outer.firstElementChild;
    if (inner) ro.observe(inner);
    ro.observe(outer);
    return () => ro.disconnect();
  }, []);

  // FLIP on content swap, before paint: pin the old width, then slide to the
  // new content's natural width; transitionend releases back to auto. Every
  // entry first clears any state a previous (possibly interrupted) slide left
  // behind — the no-op early return must not leak overflow clipping: an
  // interrupted slide fires transitioncancel, never transitionend.
  React.useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const oldWidth = lastWidthRef.current;
    outer.style.transitionProperty = "none";
    release();
    const newWidth = outer.offsetWidth;
    if (oldWidth === null || Math.abs(newWidth - oldWidth) < 1) {
      outer.style.transitionProperty = "";
      return;
    }
    outer.style.width = `${oldWidth}px`;
    outer.style.overflow = "clip";
    outer.style.overflowClipMargin = "48px";
    void outer.offsetWidth; // commit the starting width
    outer.style.transitionProperty = "";
    slidingRef.current = true;
    outer.style.width = `${newWidth}px`;
  }, [contentKey, release]);

  return (
    <div
      ref={outerRef}
      className="transition-[width] duration-200 ease-out"
      onTransitionEnd={(e) => {
        if (e.propertyName === "width" && e.target === e.currentTarget) release();
      }}
    >
      <div className="w-max">{children}</div>
    </div>
  );
}
