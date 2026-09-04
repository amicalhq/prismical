/**
 * Widget-state projection tests — the pure rule.
 *
 * `toWidgetState(recording, mainFocused, visibility)` folds the three inputs
 * into the WidgetStateView the pill renders. Detection was removed from the
 * projection (a detection is a notification CARD now — notify-policy.test.ts),
 * which also deleted the old detection-bypasses-focus special case. Exhaustive
 * matrix: the 3-way visibility rule, pill selection, timer/capability fields,
 * and the mic-only degrade projection.
 */
import { describe, expect, it } from 'vitest';
import type { WidgetVisibility } from '@prismical/desktop-contracts';
import { toWidgetState } from '../../src/main/domains/detection/widget-policy';
import { idleRecordingState, type RecordingState } from '../../src/main/domains/recording/service';

const recordingState = (over: Partial<RecordingState> = {}): RecordingState => ({
  ...idleRecordingState,
  recordingId: 'rec_1',
  status: 'recording',
  captureMode: 'dual',
  requestedCaptureMode: 'dual',
  startedAt: 1_700_000_000_000,
  ...over,
});

describe('toWidgetState — pill selection + fields ("always")', () => {
  it('idle + unfocused → a visible idle sliver', () => {
    const view = toWidgetState(idleRecordingState, false, 'always');
    expect(view).toEqual({ visible: true, mode: 'idle', recording: null });
  });

  it('idle + focused → hidden (suppressed over the focused main window)', () => {
    const view = toWidgetState(idleRecordingState, true, 'always');
    expect(view.visible).toBe(false);
    expect(view.mode).toBe('idle');
  });

  it('recording + unfocused → visible recording; micOnly false when modes match', () => {
    const view = toWidgetState(recordingState(), false, 'always');
    expect(view.visible).toBe(true);
    expect(view.mode).toBe('recording');
    expect(view.recording).toEqual({
      status: 'recording',
      micOnly: false,
      canPause: true,
      startedAt: 1_700_000_000_000,
      pausedAccumMs: 0,
      elapsedMs: 0,
      elapsedAt: null,
    });
  });

  it('recording micOnly true when the effective mode degraded from the requested', () => {
    const view = toWidgetState(
      recordingState({ requestedCaptureMode: 'dual', captureMode: 'mic' }),
      false,
      'always'
    );
    expect(view.recording?.micOnly).toBe(true);
  });

  it('startedAt projects null before the domain stamps it (starting)', () => {
    const view = toWidgetState(
      recordingState({ status: 'starting', startedAt: null }),
      false,
      'always'
    );
    expect(view.recording?.startedAt).toBeNull();
    expect(view.recording?.pausedAccumMs).toBe(0);
  });

  it('recording + focused → hidden (no more detection focus-bypass exists at all)', () => {
    const view = toWidgetState(recordingState(), true, 'always');
    expect(view.visible).toBe(false);
    expect(view.mode).toBe('recording');
  });

  it('the non-recording statuses still project as the recording pill', () => {
    for (const status of ['starting', 'stopping', 'error'] as const) {
      const view = toWidgetState(recordingState({ status }), false, 'always');
      expect(view.mode).toBe('recording');
      expect(view.recording?.status).toBe(status);
    }
  });
});

describe('toWidgetState — visibility matrix without the detection clause', () => {
  const visibleOf = (
    rec: RecordingState,
    focused: boolean,
    visibility: WidgetVisibility
  ): boolean => toWidgetState(rec, focused, visibility).visible;

  it("'never' suppresses EVERY state — idle or recording, focused or not", () => {
    const cases: Array<[RecordingState, boolean]> = [
      [idleRecordingState, false],
      [idleRecordingState, true],
      [recordingState(), false],
      [recordingState(), true],
    ];
    for (const [rec, focused] of cases) {
      expect(visibleOf(rec, focused, 'never')).toBe(false);
    }
  });

  it("'always' shows over other apps, hides over the focused main window", () => {
    expect(visibleOf(idleRecordingState, false, 'always')).toBe(true);
    expect(visibleOf(idleRecordingState, true, 'always')).toBe(false);
    expect(visibleOf(recordingState(), false, 'always')).toBe(true);
    expect(visibleOf(recordingState(), true, 'always')).toBe(false);
  });

  it("'while-recording' shows ONLY while a recording is in flight (unfocused)", () => {
    expect(visibleOf(idleRecordingState, false, 'while-recording')).toBe(false);
    expect(visibleOf(recordingState(), false, 'while-recording')).toBe(true);
    for (const status of ['starting', 'stopping', 'error'] as const) {
      expect(visibleOf(recordingState({ status }), false, 'while-recording')).toBe(true);
    }
    // recording + focused → still hidden (focus-hide beats while-recording).
    expect(visibleOf(recordingState(), true, 'while-recording')).toBe(false);
  });
});
