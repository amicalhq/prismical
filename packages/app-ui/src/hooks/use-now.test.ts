// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { relativeTickInterval, useNow } from './use-now';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The interval a row asks for is what decides how much of a long list re-renders each minute.
it('watches the clock only as closely as the label changes', () => {
  expect(relativeTickInterval(0)).toBe(60_000);
  expect(relativeTickInterval(59 * 60_000)).toBe(60_000);
  expect(relativeTickInterval(3_600_000)).toBe(3_600_000);
  expect(relativeTickInterval(23 * 3_600_000)).toBe(3_600_000);
  expect(relativeTickInterval(86_400_000)).toBe(86_400_000);
  expect(relativeTickInterval(6 * 86_400_000)).toBe(86_400_000);
});

// Past a week the label is a plain date, which no amount of waiting changes.
it('stops watching once the label cannot change', () => {
  expect(relativeTickInterval(7 * 86_400_000)).toBeNull();
  expect(relativeTickInterval(400 * 86_400_000)).toBeNull();
});

// Each test unmounts what it renders: the tickers are module state shared by every subscriber, so
// a hook left mounted would keep its interval alive into the next test's spy counts.
it('re-renders a subscriber on every tick', () => {
  const { result, unmount } = renderHook(() => useNow(60_000));
  const first = result.current;
  act(() => void vi.advanceTimersByTime(60_000));
  expect(result.current).toBeGreaterThan(first);
  unmount();
});

it('never re-renders a subscriber that asked for no interval', () => {
  const { result, unmount } = renderHook(() => useNow(null));
  const first = result.current;
  act(() => void vi.advanceTimersByTime(10 * 60_000));
  expect(result.current).toBe(first);
  unmount();
});

it('refreshes immediately when an inactive clock starts watching by the hour', () => {
  const { result, rerender, unmount } = renderHook(
    ({ intervalMs }: { intervalMs: number | null }) => useNow(intervalMs),
    { initialProps: { intervalMs: null as number | null } }
  );
  const first = result.current;
  act(() => void vi.advanceTimersByTime(3 * 3_600_000));
  rerender({ intervalMs: 3_600_000 });
  const resumed = result.current;
  act(() => void vi.advanceTimersByTime(3_600_000));
  const ticked = result.current;
  unmount();

  expect(resumed).toBe(first + 3 * 3_600_000);
  expect(ticked).toBe(first + 4 * 3_600_000);
});

it('uses the current time when the caller re-renders between clock ticks', () => {
  const { result, rerender, unmount } = renderHook(() => useNow(3_600_000));
  const first = result.current;
  act(() => void vi.advanceTimersByTime(5 * 60_000));
  const beforeRender = result.current;
  rerender();
  const refreshed = result.current;
  unmount();

  expect(beforeRender).toBe(first);
  expect(refreshed).toBe(first + 5 * 60_000);
});

// One timer per interval however many rows watch it, and none once they unmount — a list of
// hundreds of rows must not hold hundreds of intervals.
it('shares one timer across subscribers and clears it with the last', () => {
  const setInterval = vi.spyOn(globalThis, 'setInterval');
  const clearInterval = vi.spyOn(globalThis, 'clearInterval');

  const first = renderHook(() => useNow(60_000));
  const second = renderHook(() => useNow(60_000));
  const third = renderHook(() => useNow(60_000));
  expect(setInterval).toHaveBeenCalledTimes(1);

  first.unmount();
  second.unmount();
  expect(clearInterval).not.toHaveBeenCalled();
  third.unmount();
  expect(clearInterval).toHaveBeenCalledTimes(1);

  setInterval.mockRestore();
  clearInterval.mockRestore();
});

it('keeps a separate timer per interval', () => {
  const setInterval = vi.spyOn(globalThis, 'setInterval');
  const minute = renderHook(() => useNow(60_000));
  const hour = renderHook(() => useNow(3_600_000));
  expect(setInterval).toHaveBeenCalledTimes(2);

  // The hourly subscriber sits still while the minute hand moves.
  const hourly = hour.result.current;
  act(() => void vi.advanceTimersByTime(60_000));
  expect(hour.result.current).toBe(hourly);
  expect(minute.result.current).toBeGreaterThan(hourly - 1);

  minute.unmount();
  hour.unmount();
  setInterval.mockRestore();
});
