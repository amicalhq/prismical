'use client';

import * as React from 'react';

// A relative timestamp ("2m", "3h") is computed at render, so without something to re-render it,
// a list left open keeps whatever age it had when it last painted — and the sync store only
// re-renders a row when that row's data changes, which a quiet hour never does.
//
// One module-level interval serves every subscriber, so a list of fifty rows ticks once rather
// than fifty times, and the interval stops as soon as the last subscriber unmounts.

const subscribers = new Set<(now: number) => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function subscribe(callback: (now: number) => void, intervalMs: number): () => void {
  subscribers.add(callback);
  ticker ??= setInterval(() => {
    const now = Date.now();
    for (const subscriber of subscribers) subscriber(now);
  }, intervalMs);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0 && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

/**
 * The current time, re-rendering the caller every `intervalMs` (a minute by default — the
 * smallest step a compact relative timestamp can show).
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => subscribe(setNow, intervalMs), [intervalMs]);
  return now;
}
