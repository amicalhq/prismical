'use client';

import { useEffect, useRef } from 'react';

// Result IDs survive recovery; workflow/proposal IDs are recreated on reload. Keep only
// attention markers (no note content) for this tab's lifetime, with an in-memory fallback.
const attended = new Set<string>();
const storagePrefix = 'review-attended:v1:';

function wasAttended(key: string) {
  if (attended.has(key)) return true;
  try { return sessionStorage.getItem(storagePrefix + key) === '1'; }
  catch { return false; }
}

/** Decorative only: listeners never prevent or stop the dock's existing actions. */
export function useReviewShine(identity: string | undefined, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dock = ref.current;
    if (!dock || !identity || typeof window.matchMedia !== 'function') return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let stopped = wasAttended(identity);
    const stop = () => {
      stopped = true;
      attended.add(identity);
      try { sessionStorage.setItem(storagePrefix + identity, '1'); } catch { /* Storage is optional. */ }
      dock.removeAttribute('data-review-shine');
    };
    const update = () => {
      // Also catch a pointer/focus already here when a new proposal replaces the old one.
      if (dock.matches(':hover') || dock.contains(document.activeElement)) stop();
      dock.toggleAttribute('data-review-shine', ready && !stopped && !document.hidden && !motion.matches);
    };
    const events = ['pointerenter', 'pointerdown', 'touchstart', 'focusin', 'input', 'keydown', 'click'] as const;
    for (const event of events) dock.addEventListener(event, stop, { capture: true, passive: true });
    document.addEventListener('visibilitychange', update);
    motion.addEventListener('change', update);
    update();
    return () => {
      dock.removeAttribute('data-review-shine');
      for (const event of events) dock.removeEventListener(event, stop, true);
      document.removeEventListener('visibilitychange', update);
      motion.removeEventListener('change', update);
    };
  }, [identity, ready]);
  return ref;
}
