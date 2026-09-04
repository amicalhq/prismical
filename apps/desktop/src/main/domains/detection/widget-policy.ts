/**
 * Widget-state projection — a PURE function.
 *
 * Folds the three reactive inputs the dock pill depends on — the current
 * recording state, whether the main window is focused, and the user's 3-way
 * visibility setting — into the single `WidgetStateView` the pill renders. No
 * clock, no side effects: exhaustively unit-testable (widget-policy.test.ts),
 * the whole visibility rule in one place.
 *
 * Detection is not part of this projection: a meeting detection is a
 * notification CARD (notify-policy.ts) now, never a pill — which also deleted
 * the old detection-bypasses-focus-hide special case.
 *
 * Visibility rule:
 *   'never'          suppresses the pill entirely;
 *   otherwise the pill is hidden over the FOCUSED main window (it floats over
 *     OTHER apps only);
 *   otherwise 'always' shows it, and 'while-recording' shows it only while a
 *     recording is in flight (starting/recording/paused/stopping/error → mode
 *     'recording').
 */
import type { WidgetStateView, WidgetVisibility } from '@prismical/desktop-contracts';
import type { RecordingState } from '../recording/service';

export const toWidgetState = (
  recording: RecordingState,
  mainFocused: boolean,
  visibility: WidgetVisibility
): Omit<WidgetStateView, 'locale'> => {
  const mode: WidgetStateView['mode'] = recording.status !== 'idle' ? 'recording' : 'idle';

  const visible =
    visibility === 'never'
      ? false
      : mainFocused
        ? false // hide over the focused main window
        : visibility === 'always'
          ? true
          : /* 'while-recording' */ mode === 'recording';

  return {
    visible,
    mode,
    recording:
      mode === 'recording'
        ? {
            status: recording.status as Exclude<RecordingState['status'], 'idle'>,
            // The effective mode fell back to mic-only.
            micOnly: recording.requestedCaptureMode !== recording.captureMode,
            canPause: true,
            startedAt: recording.startedAt,
            pausedAccumMs: recording.pausedAccumMs,
            elapsedMs: recording.elapsedMs,
            elapsedAt: recording.elapsedAt,
          }
        : null,
  };
};
