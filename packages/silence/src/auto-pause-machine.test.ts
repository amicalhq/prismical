import { describe, expect, it } from 'vitest';
import { AUTO_PAUSE_DEFAULTS, AutoPauseMachine, type AutoPauseConfig } from './auto-pause-machine';

const CONFIG: AutoPauseConfig = {
  ...AUTO_PAUSE_DEFAULTS,
  enabled: true,
  silenceSeconds: 100,
  graceSeconds: 20,
  autoStopAfterPausedMinutes: 20,
  minSessionSeconds: 30,
};

const kinds = (effects: readonly { kind: string }[]) => effects.map(e => e.kind);

/** Drive the machine to the point the grace surface is showing. */
function toGrace(m: AutoPauseMachine, nowMs = 0) {
  return m.observe({ silentSeconds: 100, elapsedSeconds: 200, nowMs });
}

describe('AutoPauseMachine', () => {
  it('emits nothing while disabled, no matter how silent', () => {
    const m = new AutoPauseMachine({ ...CONFIG, enabled: false });
    expect(m.observe({ silentSeconds: 9999, elapsedSeconds: 9999, nowMs: 0 })).toEqual([]);
    expect(m.state).toBe('listening');
  });

  it('never fires inside the minimum session window', () => {
    const m = new AutoPauseMachine(CONFIG);
    expect(m.observe({ silentSeconds: 120, elapsedSeconds: 20, nowMs: 0 })).toEqual([]);
    expect(m.state).toBe('listening');
  });

  it('raises the grace surface at the silence threshold, with a renderer deadline', () => {
    const m = new AutoPauseMachine(CONFIG);
    const [effect, ...rest] = toGrace(m, 5_000);
    expect(rest).toEqual([]);
    expect(effect).toEqual({ kind: 'show-grace', graceMs: 20_000, deadlineMs: 25_000 });
    expect(m.state).toBe('grace');
  });

  it('raises it exactly once while the countdown runs', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    expect(m.observe({ silentSeconds: 105, elapsedSeconds: 205, nowMs: 1 })).toEqual([]);
    expect(m.observe({ silentSeconds: 110, elapsedSeconds: 210, nowMs: 2 })).toEqual([]);
    expect(m.state).toBe('grace');
  });

  it('commits the pause when the countdown lapses untouched', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    const effects = m.observe({ silentSeconds: 120, elapsedSeconds: 220, nowMs: 3 });
    expect(kinds(effects)).toEqual(['hide-grace', 'pause']);
    expect(m.state).toBe('committing');
  });

  it('withdraws the surface when speech returns during grace', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    const effects = m.observe({ silentSeconds: 0, elapsedSeconds: 210, nowMs: 4 });
    expect(kinds(effects)).toEqual(['hide-grace']);
    expect(m.state).toBe('listening');
  });

  it('withdraws the surface when the ASR returns text (the two-signal rule)', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    expect(kinds(m.speechTranscribed())).toEqual(['hide-grace']);
    expect(m.state).toBe('listening');
    // …and is a no-op when no surface is up.
    expect(m.speechTranscribed()).toEqual([]);
  });

  it('suppresses for the rest of the session on Keep recording', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    expect(kinds(m.keepRecording())).toEqual(['hide-grace']);
    expect(m.isSuppressed).toBe(true);
    // Never asks again, however silent it gets.
    expect(m.observe({ silentSeconds: 9999, elapsedSeconds: 9999, nowMs: 5 })).toEqual([]);
  });

  it('treats any pre-grace interaction as Keep recording without emitting a hide', () => {
    const m = new AutoPauseMachine(CONFIG);
    expect(m.keepRecording()).toEqual([]);
    expect(m.isSuppressed).toBe(true);
  });

  it('commits immediately on the explicit Pause button, attributed to the USER', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    const effects = m.pauseNow();
    expect(kinds(effects)).toEqual(['hide-grace', 'pause']);
    expect(effects[1]).toEqual({ kind: 'pause', attributed: 'user' });
    expect(m.state).toBe('committing');
    // Not a valid transition from anywhere else.
    const other = new AutoPauseMachine(CONFIG);
    expect(other.pauseNow()).toEqual([]);
  });

  it('attributes a lapsed countdown to SILENCE, not the user', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    const effects = m.observe({ silentSeconds: 120, elapsedSeconds: 220, nowMs: 0 });
    expect(effects[1]).toEqual({ kind: 'pause', attributed: 'silence' });
  });

  it('rearms when the pause fails instead of hanging in committing', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    m.observe({ silentSeconds: 120, elapsedSeconds: 220, nowMs: 6 });
    expect(m.state).toBe('committing');
    m.notePauseFailed();
    expect(m.state).toBe('listening');
  });

  it('is inert to frames while committing or paused', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    m.observe({ silentSeconds: 120, elapsedSeconds: 220, nowMs: 7 });
    expect(m.observe({ silentSeconds: 300, elapsedSeconds: 400, nowMs: 8 })).toEqual([]);
    m.notePaused(10_000);
    expect(m.observe({ silentSeconds: 300, elapsedSeconds: 400, nowMs: 9 })).toEqual([]);
  });

  it('auto-stops after the paused window, exactly once', () => {
    const m = new AutoPauseMachine(CONFIG);
    m.notePaused(1_000);
    expect(m.tick(1_000 + 19 * 60_000)).toEqual([]);
    expect(kinds(m.tick(1_000 + 20 * 60_000))).toEqual(['stop']);
    expect(m.state).toBe('stopped');
    expect(m.tick(1_000 + 40 * 60_000)).toEqual([]);
  });

  it('auto-stops a MANUALLY paused session too', () => {
    // A session the user paused and abandoned deserves finalizing just as much as one we paused.
    const m = new AutoPauseMachine(CONFIG);
    m.notePaused(0);
    expect(kinds(m.tick(20 * 60_000))).toEqual(['stop']);
  });

  it('never auto-stops when the window is 0', () => {
    const m = new AutoPauseMachine({ ...CONFIG, autoStopAfterPausedMinutes: 0 });
    m.notePaused(0);
    expect(m.tick(10 * 60 * 60_000)).toEqual([]);
  });

  it('cancels the auto-stop clock on resume', () => {
    const m = new AutoPauseMachine(CONFIG);
    m.notePaused(0);
    m.noteResumed();
    expect(m.state).toBe('listening');
    expect(m.tick(60 * 60_000)).toEqual([]);
  });

  it('keeps suppression across a FULL pause/resume cycle', () => {
    // Suppression is a flag, not a phase, precisely so the dock's Pause can't quietly clear it: as
    // a phase, a coffee break three minutes after "Keep recording" re-armed the prompt.
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    m.keepRecording();
    m.notePaused(1_000);
    m.noteResumed();
    expect(m.isSuppressed).toBe(true);
    expect(m.observe({ silentSeconds: 9999, elapsedSeconds: 9999, nowMs: 11 })).toEqual([]);
  });

  it('still auto-stops a suppressed session that was left paused', () => {
    // Suppression means "stop guessing", not "abandon the recording forever".
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    m.keepRecording();
    m.notePaused(0);
    expect(kinds(m.tick(20 * 60_000))).toEqual(['stop']);
  });

  it('is terminal after the session stops', () => {
    const m = new AutoPauseMachine(CONFIG);
    m.noteStopped();
    expect(m.observe({ silentSeconds: 9999, elapsedSeconds: 9999, nowMs: 12 })).toEqual([]);
    expect(m.keepRecording()).toEqual([]);
    m.notePaused(0);
    expect(m.state).toBe('stopped');
  });

  it('takes a live config swap', () => {
    const m = new AutoPauseMachine({ ...CONFIG, enabled: false });
    expect(m.observe({ silentSeconds: 200, elapsedSeconds: 300, nowMs: 13 })).toEqual([]);
    m.configure(CONFIG);
    expect(kinds(m.observe({ silentSeconds: 200, elapsedSeconds: 300, nowMs: 13 }))).toEqual(['show-grace']);
  });
});

// ---------------------------------------------------------------------------
// Adversarial regression cases. Each FAILED before the fix.
// ---------------------------------------------------------------------------
describe('AutoPauseMachine — adversarial regressions', () => {
  it('gives a FULL countdown when the gate turns on mid-session with silence already banked', () => {
    // The normal startup path: the org query resolves a few seconds in, so `enabled` flips true
    // while silentSeconds is already large. Comparing against the absolute threshold showed the
    // card and committed the pause on the very next frame (~8ms) — destroying the one property the
    // whole design leans on, that a false positive costs a dismissed card rather than lost audio.
    const m = new AutoPauseMachine({ ...CONFIG, enabled: false });
    m.observe({ silentSeconds: 200, elapsedSeconds: 300, nowMs: 0 });
    m.configure(CONFIG);
    expect(kinds(m.observe({ silentSeconds: 200, elapsedSeconds: 300, nowMs: 0 }))).toEqual(['show-grace']);
    // One frame later: still counting down, NOT paused.
    expect(m.observe({ silentSeconds: 200.008, elapsedSeconds: 300, nowMs: 8 })).toEqual([]);
    expect(m.state).toBe('grace');
    // It commits a full graceSeconds after the card went up.
    expect(kinds(m.observe({ silentSeconds: 220, elapsedSeconds: 320, nowMs: 20_000 }))).toEqual([
      'hide-grace',
      'pause',
    ]);
  });

  it('retracts the surface when the gate is turned off mid-grace, instead of stranding it', () => {
    // A TanStack refetch that transiently resolves no matching org flips `enabled` false. The early
    // return meant the machine could then neither hide the card nor commit — it hung forever.
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    m.configure({ ...CONFIG, enabled: false });
    expect(kinds(m.observe({ silentSeconds: 999, elapsedSeconds: 999, nowMs: 1 }))).toEqual(['hide-grace']);
    expect(m.state).toBe('listening');
  });

  it('takes the surface down when the user pauses from the dock while it is up', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    expect(kinds(m.notePaused(1_000))).toEqual(['hide-grace']);
    expect(m.state).toBe('paused');
  });

  it('takes the surface down when the session stops while it is up', () => {
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    expect(kinds(m.noteStopped())).toEqual(['hide-grace']);
    expect(m.state).toBe('stopped');
  });

  it('honours a Keep-recording click that lands just after the countdown lapsed', () => {
    // The countdown resolves on a frame boundary (~8ms), so a click can arrive a hair late. We
    // cannot un-emit the pause, but the session must never ask again.
    const m = new AutoPauseMachine(CONFIG);
    toGrace(m);
    m.observe({ silentSeconds: 120, elapsedSeconds: 220, nowMs: 0 }); // → committing
    m.keepRecording();
    expect(m.isSuppressed).toBe(true);
    expect(m.observe({ silentSeconds: 999, elapsedSeconds: 999, nowMs: 1 })).toEqual([]);
  });

  it('ignores a non-finite silence figure instead of raising the card forever', () => {
    // The machine takes silentSeconds from an arbitrary caller (desktop MAIN combines lanes
    // itself). NaN fails every `<`, so it used to show the card on frame one and hang in grace.
    const m = new AutoPauseMachine(CONFIG);
    expect(m.observe({ silentSeconds: Number.NaN, elapsedSeconds: 300, nowMs: 0 })).toEqual([]);
    expect(m.observe({ silentSeconds: 200, elapsedSeconds: Number.NaN, nowMs: 0 })).toEqual([]);
    expect(m.state).toBe('listening');
  });
});
