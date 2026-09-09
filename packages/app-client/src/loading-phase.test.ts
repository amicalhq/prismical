// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { startLoadingTiming } from './loading-timing';

const diagnosticWindow = window as Window & { __PRISMICAL_LOADING_PHASES__?: boolean };
const events: Array<Record<string, unknown>> = [];
const receive = (event: Event) => events.push((event as CustomEvent).detail);
window.addEventListener('prismical:loading-phase', receive);
afterEach(() => {
  vi.restoreAllMocks();
  delete diagnosticWindow.__PRISMICAL_LOADING_PHASES__;
  events.length = 0;
  vi.useRealTimers();
});

it('isolates a broken event sink from phase marking and analytics completion', () => {
  diagnosticWindow.__PRISMICAL_LOADING_PHASES__ = true;
  vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
    throw new Error('recorder unavailable');
  });
  const capture = vi.fn();
  const timing = startLoadingTiming({ capture, capturePageview: vi.fn() }, 'note_collaboration');
  expect(() => timing.mark('token_requested')).not.toThrow();
  expect(() => timing.finish('ready')).not.toThrow();
  expect(capture).toHaveBeenCalledTimes(2);
});

it('emits nothing without opt-in while preserving analytics outcomes', () => {
  const capture = vi.fn();
  const timing = startLoadingTiming({ capture, capturePageview: vi.fn() }, 'note_collaboration');
  timing.mark('token_requested');
  timing.finish('ready');
  expect(events).toEqual([]);
  expect(capture).toHaveBeenCalledTimes(2);
});

it('captures phases before analytics filtering with a calibrated monotonic clock', () => {
  diagnosticWindow.__PRISMICAL_LOADING_PHASES__ = true;
  const timing = startLoadingTiming(undefined, 'note_collaboration', 'nt_abcdefghijklmnop');
  timing.mark('provider_constructing', 1);
  timing.mark('token_requested', 1);
  timing.mark('token_resolved', 1);
  timing.finish('ready');
  expect(events.map(event => event.phase)).toEqual([
    'started',
    'provider_constructing',
    'token_requested',
    'token_resolved',
    'ready',
  ]);
  expect(events[0]).toMatchObject({
    version: 1,
    noteId: 'nt_abcdefghijklmnop',
    attemptId: timing.attemptId,
  });
  expect(Number(events[0]!.timeOriginMs) + Number(events[0]!.monotonicMs)).toBeCloseTo(
    Date.now(),
    -2
  );
  expect(events.map(event => event.monotonicMs)).toEqual(
    events.map(event => event.monotonicMs).sort((a, b) => Number(a) - Number(b))
  );
});

it('retains only allowlisted fields and phases; rejects arbitrary content', () => {
  diagnosticWindow.__PRISMICAL_LOADING_PHASES__ = true;
  const timing = startLoadingTiming(undefined, 'note_collaboration', 'private document contents');
  timing.mark('secret bearer token');
  timing.mark('token_requested');
  timing.finish('abandoned');
  expect(events.map(event => event.phase)).toEqual(['started', 'token_requested', 'abandoned']);
  expect(JSON.stringify(events)).not.toMatch(/private|secret|bearer/);
  expect(events.every(event => !('noteId' in event))).toBe(true);
  expect(Object.keys(events[0]!).sort()).toEqual([
    'attemptId',
    'elapsedMs',
    'kind',
    'monotonicMs',
    'phase',
    'timeOriginMs',
    'version',
  ]);
});

it('distinguishes remounts and connection retries and ignores late abandoned events', () => {
  diagnosticWindow.__PRISMICAL_LOADING_PHASES__ = true;
  const first = startLoadingTiming(undefined, 'note_collaboration');
  first.mark('token_requested', 1);
  first.mark('token_requested', 1);
  first.mark('token_requested', 2);
  first.finish('abandoned');
  first.mark('token_resolved', 2);
  const second = startLoadingTiming(undefined, 'note_collaboration');
  second.finish('ready');
  expect(first.attemptId).not.toBe(second.attemptId);
  expect(
    events.filter(event => event.phase === 'token_requested').map(event => event.connectionAttempt)
  ).toEqual([1, 2]);
  expect(events.some(event => event.phase === 'token_resolved')).toBe(false);
});

it('caps repeated retry phases and explicitly reports truncation', () => {
  diagnosticWindow.__PRISMICAL_LOADING_PHASES__ = true;
  const timing = startLoadingTiming(undefined, 'note_collaboration');
  for (let attempt = 1; attempt <= 1000; attempt++) timing.mark('token_requested', attempt);
  timing.finish('error');
  expect(events.length).toBe(65);
  expect(events.at(-1)?.phase).toBe('truncated');
});

it('keeps delayed phases unknown at the original five-second boundary', () => {
  vi.useFakeTimers();
  diagnosticWindow.__PRISMICAL_LOADING_PHASES__ = true;
  const timing = startLoadingTiming(undefined, 'note_collaboration');
  timing.mark('provider_constructing', 1);
  vi.advanceTimersByTime(5000);
  const frozen = structuredClone(events);
  expect(frozen.at(-1)?.phase).toBe('pending_at_five_seconds');
  expect(frozen.some(event => event.phase === 'authenticated')).toBe(false);
  timing.mark('authenticated', 1);
  timing.mark('document_synced', 1);
  timing.finish('ready');
  expect(frozen.some(event => event.phase === 'document_synced')).toBe(false);
});
