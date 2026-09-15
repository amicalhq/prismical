'use client';

import * as React from 'react';

/**
 * How many of a row's items fit on ONE line. When they all fit, every one is drawn; otherwise room
 * is kept at the end for what must stay visible, and the count is however many items fit before
 * that room. Two kinds of trailing control: `trailing` is always there (a create chip), while
 * `counter` only appears once something is left out (the "+N" chip), so it is budgeted only in
 * that case. Pure, so the arithmetic is testable without a layout engine.
 */
export function fitCount(
  widths: readonly number[],
  available: number,
  gap: number,
  trailing: number,
  counter = 0
): number {
  const room = (width: number) => (width > 0 ? gap + width : 0);
  let all = 0;
  widths.forEach((width, index) => {
    all += (index > 0 ? gap : 0) + width;
  });
  if (all + room(trailing) <= available) return widths.length;
  const reserved = room(counter) + room(trailing);
  let used = 0;
  let fit = 0;
  for (let index = 0; index < widths.length; index++) {
    const next = used + (index > 0 ? gap : 0) + widths[index]!;
    if (next + reserved > available) break;
    used = next;
    fit = index + 1;
  }
  return fit;
}

/**
 * Measures a single-line row of items against its container and says how many to draw. Every item
 * stays rendered so it can be measured: the ones past the count are kept out of the flow by the
 * caller (`invisible absolute`) rather than unmounted, or their width could never be read. The
 * same goes for the counter: the caller keeps a measurable stand-in for it while nothing is left
 * out, or the row would only learn the counter's width after it had already overflowed.
 *
 * `signature` names the items: change it when their labels change, and the row re-measures.
 * `trailingRef` goes on the box that always ends the row; `counterRef` on the counter, or its
 * stand-in. The gap is read from the container's own `column-gap`, with `fallbackGap` where
 * there is no layout to ask.
 */
export function useFitCount(count: number, signature: string, fallbackGap = 8) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const trailingRef = React.useRef<HTMLElement | null>(null);
  const counterRef = React.useRef<HTMLElement | null>(null);
  const items = React.useRef<(HTMLElement | null)[]>([]);
  const [fit, setFit] = React.useState(count);

  const measure = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const widths: number[] = [];
    for (let index = 0; index < count; index++) widths.push(items.current[index]?.offsetWidth ?? 0);
    const styledGap =
      typeof getComputedStyle === 'function'
        ? Number.parseFloat(getComputedStyle(container).columnGap)
        : Number.NaN;
    const gap = Number.isFinite(styledGap) ? styledGap : fallbackGap;
    setFit(
      fitCount(
        widths,
        container.clientWidth,
        gap,
        trailingRef.current?.offsetWidth ?? 0,
        counterRef.current?.offsetWidth ?? 0
      )
    );
    // The signature is what changes the widths, so it belongs in the dependencies even though the
    // body never reads it.
    void signature;
  }, [count, fallbackGap, signature]);

  React.useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  const itemRef = React.useCallback(
    (index: number) => (element: HTMLElement | null) => {
      items.current[index] = element;
    },
    []
  );

  return { containerRef, trailingRef, counterRef, itemRef, fit: Math.min(fit, count) };
}
