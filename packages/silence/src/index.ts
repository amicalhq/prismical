/**
 * @prismical/silence — auto-pause on silence, plus dead-mic detection.
 *
 * Zero runtime dependencies, framework-free, DOM-free: the SAME code runs in the Next.js browser
 * bundle (web capture), the desktop renderer, and the desktop MAIN process (native capture). That
 * is the whole point of the package — web renders the machine's effects as a sonner toast and
 * desktop renders them as an `auto-pause` notify card, but the decision itself is made
 * once, here, so the two platforms cannot drift.
 *
 * Wiring, per platform:
 *
 *   web       one SilenceWatcher fed from the AudioWorklet frame handler (16 kHz).
 *   desktop   one SilenceWatcher PER LANE fed from `onFrame` (48 kHz), combined with
 *             `combinedSilentSeconds` below — a dual recording is only silent when BOTH lanes are.
 *             System audio alone (a video playing, the far side talking while your mic is muted)
 *             is emphatically not silence and must never pause.
 *
 * DeadMicWatcher is a separate question from all of the above and must not be confused with it:
 * SilenceWatcher asks whether anyone is TALKING (relative to a tracked noise floor, so a quiet
 * room reads as silent), while DeadMicWatcher asks whether the stream carries ANY signal at all
 * (absolute, so only exact zeros qualify). A quiet room is silence; it is never a dead mic. Both
 * run off the same frames — see dead-mic-watcher.ts.
 */

export {
  SilenceWatcher,
  frameRms,
  FRAME_RMS_FLOOR,
  SPEECH_OVER_FLOOR,
  FLOOR_WINDOW_S,
  FLOOR_BUCKET_S,
  type SilenceWatcherOptions,
} from './silence-watcher';

export {
  DeadMicWatcher,
  DEAD_MIC_PEAK,
  DEAD_MIC_SECONDS,
  DEAD_MIC_RECOVERY_SECONDS,
} from './dead-mic-watcher';

export {
  AutoPauseMachine,
  AUTO_PAUSE_DEFAULTS,
  type AutoPauseConfig,
  type AutoPauseEffect,
  type AutoPauseObservation,
  type AutoPausePhase,
} from './auto-pause-machine';

import type { SilenceWatcher } from './silence-watcher';

/**
 * Silence across N capture lanes: the shortest silent run wins, because the session has only been
 * silent for as long as its most recently active lane. System audio alone (a video playing, the
 * far side talking while your mic is muted) is emphatically not silence.
 *
 * Lanes that have received NO audio at all are excluded, not counted as 0. A dual recording whose
 * system lane never produces a frame — no loopback device, permission declined, nothing playing —
 * would otherwise pin the minimum at zero forever and silently disable auto-pause on the platform
 * where the waste is doubled. Returns 0 when nothing has been captured at all, which correctly
 * means "no silence observed yet".
 */
export function combinedSilentSeconds(watchers: readonly SilenceWatcher[]): number {
  let min = Infinity;
  for (const w of watchers) {
    if (w.elapsedSeconds <= 0) continue;
    if (w.silentSeconds < min) min = w.silentSeconds;
  }
  return Number.isFinite(min) ? min : 0;
}
