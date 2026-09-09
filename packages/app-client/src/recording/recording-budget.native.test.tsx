// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { NativeRecordingControl, NativeRecordingState } from '@prismical/app-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecordingBudgetWarning } from './recording-budget';

const fixture = vi.hoisted(() => ({
  control: undefined as NativeRecordingControl | undefined,
  limit: 3600 as number | null,
  transcription: null as { instanceId: string; modelId: string } | null,
  usedSeconds: 600,
}));
vi.mock('../ports-context', () => ({
  usePorts: () => ({ recording: { control: fixture.control } }),
}));
vi.mock('../api/hooks/usage', () => ({
  useCloudTranscriptionQuota: () => ({ limitSeconds: 1200, usedSeconds: fixture.usedSeconds }),
}));
vi.mock('../api/hooks/organizations', () => ({
  useEntitlements: () => ({ entitlements: { limits: { maxRecordingSeconds: fixture.limit } } }),
}));
vi.mock('../api/hooks/model-defaults', () => ({
  useModelDefaults: () => ({ data: { transcription: fixture.transcription } }),
}));

afterEach(cleanup);
beforeEach(() => {
  fixture.control = undefined;
  fixture.limit = 3600;
  fixture.transcription = null;
  fixture.usedSeconds = 600;
});

const recording = (spendsCloudQuota: NativeRecordingState['spendsCloudQuota']): NativeRecordingState => ({
  recordingId: 'rec_1',
  finalizingRecordingIds: [],
  completedRecordings: [],
  status: 'recording',
  captureMode: 'mic',
  requestedCaptureMode: 'mic',
  spendsCloudQuota,
  quotaRemainingAtStartSeconds: 600,
  micSource: 'system-default',
  noteId: 'note_1',
  segments: [],
  elapsedMs: 0,
});

function nativeControl(initial: NativeRecordingState) {
  let listener: ((state: NativeRecordingState) => void) | undefined;
  fixture.control = {
    start: vi.fn(),
    stop: vi.fn(),
    claimCompletion: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    subscribe: next => {
      listener = next;
      next(initial);
      return () => {
        listener = undefined;
      };
    },
  };
  return (next: NativeRecordingState) => act(() => listener?.(next));
}

describe('recording budget native quota', () => {
  it('keeps session warnings without Cloud quota warnings for an unmetered native recording', () => {
    nativeControl(recording(false));
    const { result, rerender } = renderHook(
      ({ elapsedSeconds }) => useRecordingBudgetWarning({ sessionId: 'rec_1', elapsedSeconds }),
      { initialProps: { elapsedSeconds: 0 } },
    );
    expect(result.current.warning).toBeNull();
    rerender({ elapsedSeconds: 3400 });
    expect(result.current.warning).toMatchObject({ kind: 'session', thresholdSeconds: 300 });
  });

  it('uses the native recording quota snapshot even after the server model default changes', () => {
    nativeControl(recording(true));
    const { result, rerender } = renderHook(() =>
      useRecordingBudgetWarning({ sessionId: 'rec_1', elapsedSeconds: 0 }),
    );
    expect(result.current.warning).toMatchObject({ kind: 'quota', remainingSeconds: 600 });
    fixture.transcription = { instanceId: 'instance_1', modelId: 'nova-3' };
    rerender();
    expect(result.current.warning).toMatchObject({ kind: 'quota', remainingSeconds: 600 });
  });

  it('uses the original allowance when a later window has already-metered usage', () => {
    fixture.usedSeconds = 360;
    nativeControl({ ...recording(true), quotaRemainingAtStartSeconds: 1200 });
    const { result } = renderHook(() =>
      useRecordingBudgetWarning({ sessionId: 'rec_1', elapsedSeconds: 360 }),
    );
    // Twenty minutes at Start, six recorded: fourteen left, not eight.
    expect(result.current.warning).toMatchObject({
      kind: 'quota',
      remainingSeconds: 840,
      thresholdSeconds: 900,
    });
  });

  it.each([undefined, null])(
    'does not infer an unknown starting allowance (%s) from current usage',
    quotaRemainingAtStartSeconds => {
      nativeControl({ ...recording(true), quotaRemainingAtStartSeconds });
      const { result } = renderHook(() =>
        useRecordingBudgetWarning({ sessionId: 'rec_1', elapsedSeconds: 0 }),
      );
      expect(result.current.warning).toBeNull();
    },
  );

  it('waits for matching native quota state and accepts a new session after pause', () => {
    const push = nativeControl(recording(undefined));
    const { result, rerender } = renderHook(
      ({ sessionId }) => useRecordingBudgetWarning({ sessionId, elapsedSeconds: 0 }),
      { initialProps: { sessionId: 'rec_1' } },
    );
    expect(result.current.warning).toBeNull();
    push(recording(true));
    expect(result.current.warning).toMatchObject({ kind: 'quota' });
    act(() => result.current.dismiss(result.current.warning!));
    push({ ...recording(true), status: 'paused' });
    expect(result.current.warning).toBeNull();
    rerender({ sessionId: 'rec_2' });
    expect(result.current.warning).toBeNull();
    push({ ...recording(false), recordingId: 'rec_2' });
    expect(result.current.warning).toBeNull();
    rerender({ sessionId: 'rec_3' });
    push({ ...recording(true), recordingId: 'rec_3' });
    expect(result.current.warning).toMatchObject({ kind: 'quota' });
  });

  it('keeps the web default behavior when there is no native control', () => {
    const { result, rerender } = renderHook(() =>
      useRecordingBudgetWarning({ sessionId: 'rec_web', elapsedSeconds: 0 }),
    );
    expect(result.current.warning).toMatchObject({ kind: 'quota' });
    fixture.transcription = { instanceId: 'instance_1', modelId: 'nova-3' };
    rerender();
    expect(result.current.warning).toBeNull();
  });
});
