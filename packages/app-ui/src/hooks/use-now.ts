'use client';

import * as React from 'react';

// A relative timestamp ("2m", "3h") is computed at render, so without something to re-render it,
// a list left open keeps whatever age it had when it last painted — and the sync store only
// re-renders a row when that row's data changes, which a quiet hour never does.
//
// Subscribers share a ticker per interval, so a list of fifty rows watching the minute ticks once
// rather than fifty times, and each ticker stops as soon as its last subscriber goes. Callers ask
// for the interval their own label actually changes on (see `relativeTickInterval`) and pass null
// once it cannot change at all, which is what keeps a long list from re-rendering end to end every
// minute to refresh labels that read the same either way.

const tickers = new Map<number, { timer: ReturnType<typeof setInterval>; listeners: Set<(now: number) => void> }>();

function subscribe(listener: (now: number) => void, intervalMs: number): () => void {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const listeners = new Set<(now: number) => void>();
    const timer = setInterval(() => {
      const now = Date.now();
      for (const each of listeners) each(now);
    }, intervalMs);
    ticker = { timer, listeners };
    tickers.set(intervalMs, ticker);
  }
  ticker.listeners.add(listener);
  return () => {
    const current = tickers.get(intervalMs);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      clearInterval(current.timer);
      tickers.delete(intervalMs);
    }
  };
}

/**
 * The current time, re-rendering the caller every `intervalMs`. Pass null to stop watching the
 * clock — for a label that no longer changes, such as an age old enough to render as a date.
 */
export function useNow(intervalMs: number | null): number {
  // The tick triggers a render; a prop-driven render must also read the current time.
  // Reusing the previous tick's timestamp would leave updated notes with a stale age.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (intervalMs === null) return;
    return subscribe(setTick, intervalMs);
  }, [intervalMs]);
  return Date.now();
}

/**
 * How often a compact relative age ("now", "5m", "3h", "2d") actually changes, given how old it is:
 * by the minute for the first hour, by the hour for the first day, by the day for the first week,
 * and never once it has become a plain date. Crossing a boundary re-renders the caller, which then
 * asks for the slower interval — so a row settles down on its own as its note ages.
 */
export function relativeTickInterval(elapsedMs: number): number | null {
  if (elapsedMs < 3_600_000) return 60_000;
  if (elapsedMs < 86_400_000) return 3_600_000;
  if (elapsedMs < 7 * 86_400_000) return 86_400_000;
  return null;
}
