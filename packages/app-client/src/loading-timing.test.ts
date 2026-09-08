import { afterEach, expect, it, vi } from 'vitest';
import { startLoadingTiming } from './loading-timing';

afterEach(() => vi.useRealTimers());

it('records the pending phases at five seconds without terminating the load', () => {
  vi.useFakeTimers();
  let clock = 0;
  const capture = vi.fn();
  const timing = startLoadingTiming(
    { capture, capturePageview: vi.fn() },
    'note_collaboration',
    'note',
    () => clock
  );
  clock = 150;
  timing.mark('socket_connected');
  clock = 5000;
  vi.advanceTimersByTime(5000);
  expect(capture.mock.calls.at(-1)?.[1]).toMatchObject({
    status: 'pending_at_five_seconds',
    elapsed_ms: 5000,
    socket_connected_ms: 150,
  });
  clock = 6000;
  timing.mark('document_synced');
  timing.finish('ready');
  expect(capture.mock.calls.at(-1)?.[1]).toMatchObject({
    status: 'ready',
    elapsed_ms: 6000,
    socket_connected_ms: 150, document_synced_ms: 6000,
  });
  timing.finish('abandoned');
  timing.mark('socket_connected');
  vi.advanceTimersByTime(10000);
  expect(capture).toHaveBeenCalledTimes(3);
});

it('clears pending timers on fast success, errors and unmounts', () => {
  vi.useFakeTimers();
  const capture = vi.fn();
  for (const status of ['published', 'error', 'abandoned'] as const) {
    const timing = startLoadingTiming({ capture, capturePageview: vi.fn() }, 'sync_bootstrap');
    timing.finish(status);
  }
  vi.advanceTimersByTime(10000);
  expect(capture).toHaveBeenCalledTimes(6);
  expect(new Set(capture.mock.calls.map(([, p]) => p.attempt_id)).size).toBe(3);
});

it('isolates analytics failures from every loading boundary', () => {
  vi.useFakeTimers();
  const capture = vi.fn(() => {
    throw new Error('analytics unavailable');
  });
  const timing = startLoadingTiming({ capture, capturePageview: vi.fn() }, 'sync_bootstrap');
  expect(() => timing.mark('notes_loaded')).not.toThrow();
  expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  expect(() => timing.finish('published')).not.toThrow();
});
