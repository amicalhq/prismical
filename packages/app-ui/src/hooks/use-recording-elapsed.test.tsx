// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { UseRecording } from '@prismical/app-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRecordingElapsed } from './use-recording-elapsed';

type ClockRecording = Pick<UseRecording, 'state' | 'startedAt' | 'nativeElapsed'>;
const startedAt = '2026-09-01T12:00:00.000Z';
const now = Date.parse(startedAt) + 30 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('reopens a paused native recording at captured time and retains the final Stop duration', () => {
  const paused: ClockRecording = {
    state: 'paused',
    startedAt,
    nativeElapsed: { status: 'paused', elapsedMs: 10 * 60_000, elapsedAt: now - 20 * 60_000 },
  };
  const { result, rerender } = renderHook(useRecordingElapsed, { initialProps: paused });
  expect(result.current).toBe(600);
  act(() => vi.advanceTimersByTime(20 * 60_000));
  expect(result.current).toBe(600);
  rerender({
    ...paused,
    state: 'recording',
    nativeElapsed: { status: 'recording', elapsedMs: 600_000, elapsedAt: Date.now() },
  });
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current).toBe(605);
  rerender({
    ...paused,
    state: 'idle',
    startedAt: null,
    nativeElapsed: { status: 'idle', elapsedMs: 605_000, elapsedAt: Date.now() },
  });
  act(() => vi.advanceTimersByTime(60_000));
  expect(result.current).toBe(605);
  rerender({
    ...paused,
    state: 'starting',
    // Start intent precedes main's next snapshot while it resolves capture configuration.
    nativeElapsed: { status: 'idle', elapsedMs: 605_000, elapsedAt: Date.now() },
  });
  expect(result.current).toBe(0);
});

it('interpolates a late running native snapshot without counting prior pauses', () => {
  const recording: ClockRecording = {
    state: 'recording',
    startedAt,
    nativeElapsed: { status: 'recording', elapsedMs: 600_000, elapsedAt: now - 2000 },
  };
  const { result } = renderHook(useRecordingElapsed, { initialProps: recording });
  expect(result.current).toBe(602);
  act(() => vi.advanceTimersByTime(3000));
  expect(result.current).toBe(605);
});

it('keeps the browser timer pause and Stop behavior', () => {
  const recording: ClockRecording = { state: 'starting', startedAt: null, nativeElapsed: null };
  const { result, rerender } = renderHook(useRecordingElapsed, { initialProps: recording });
  rerender({ ...recording, state: 'recording' });
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current).toBe(5);
  rerender({ ...recording, state: 'paused' });
  act(() => vi.advanceTimersByTime(20 * 60_000));
  expect(result.current).toBe(5);
  rerender({ ...recording, state: 'recording' });
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current).toBe(10);
  rerender({ ...recording, state: 'idle' });
  act(() => vi.advanceTimersByTime(60_000));
  expect(result.current).toBe(10);
});
