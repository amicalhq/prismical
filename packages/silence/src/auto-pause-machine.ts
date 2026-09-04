/**
 * The auto-pause state machine is pure and shared verbatim by the web renderer
 * and the desktop MAIN process so the two surfaces cannot drift on thresholds or edge cases. Web
 * renders its effects as a sonner toast; desktop renders them as an `auto-pause` notify
 * card. Same machine, two renderers.
 *
 * Silence does NOT pause immediately. It raises a
 * "Still there?" GRACE card with a countdown, and the pause commits only when that countdown lapses
 * unanswered. That ordering is what makes the whole feature safe — a false positive becomes a card
 * the user dismisses instead of lost audio, so the detector only has to be roughly right.
 *
 * THE INTERACTION IS A PRESENCE ORACLE. Any touch of the card proves a human is there, which is
 * exactly what the detector was guessing at. So every interaction EXCEPT the explicit "Pause"
 * resolves to `keepRecording()` — button, body click, dismiss, close. Only an untouched, lapsed
 * countdown commits. (This also settles what `'dismiss'` means for 166's auto-pause card, which its
 * design left undefined.) Inverting the usual toast convention — where dismissing cancels the
 * pending action — is safe precisely because the ambiguous case resolves toward NOT pausing.
 *
 * Clocks: the grace countdown is authoritative on the SAMPLE clock (via `silentSeconds`), because
 * audio still flows during grace and background tabs throttle timers. `deadlineMs` rides along
 * purely so the renderer can animate a loader; if frames stall the bar finishes early and nothing
 * happens. Auto-stop is the exception: no
 * frames flow while paused, so it runs on wall-clock `tick(nowMs)`.
 */

export type AutoPausePhase =
  /** Capturing, watching the silence counter. */
  | 'listening'
  /** The "Still there?" surface is up and counting down. */
  | 'grace'
  /** `pause` was emitted; awaiting the caller's confirmation (pause can fail). */
  | 'committing'
  /** Confirmed paused — the auto-stop clock is running. */
  | 'paused'
  /** Auto-stop fired; the session is over as far as this machine is concerned. */
  | 'stopped';

export interface AutoPauseConfig {
  /** The gate (`features.autoPauseOnSilence`). False ⇒ the machine never emits anything. */
  readonly enabled: boolean;
  /** Silence before the grace surface is raised. */
  readonly silenceSeconds: number;
  /** Countdown on that surface before the pause commits. */
  readonly graceSeconds: number;
  /** Minutes paused before auto-finalizing the recording. 0 ⇒ never auto-stop. */
  readonly autoStopAfterPausedMinutes: number;
  /**
   * Never fire in the first N seconds of a session regardless of the above: pausing right after
   * the user pressed record reads as "the button is broken", and the chunker's warm-up window is
   * where cadence is least representative anyway.
   */
  readonly minSessionSeconds: number;
}

export const AUTO_PAUSE_DEFAULTS: AutoPauseConfig = {
  enabled: false,
  silenceSeconds: 100,
  graceSeconds: 20,
  autoStopAfterPausedMinutes: 20,
  minSessionSeconds: 30,
};

export type AutoPauseEffect =
  /** Raise the grace surface. `deadlineMs`/`graceMs` drive the renderer's loader only. */
  | { readonly kind: 'show-grace'; readonly graceMs: number; readonly deadlineMs: number }
  /** Take it down (speech returned, the user answered, or the pause committed). */
  | { readonly kind: 'hide-grace' }
  /**
   * Commit the pause — the caller invokes the ONE pause primitive and reports back.
   * `attributed` is who owns the decision, and it drives copy, analytics and (on web) whether a
   * "we paused this for you" toast appears at all: a countdown the user let lapse is OURS, while
   * pressing the prompt's Pause button is THEIRS and needs no explanation.
   */
  | { readonly kind: 'pause'; readonly attributed: 'silence' | 'user' }
  /** Auto-stop: run the normal stop path so the recording finalizes into a real note. */
  | { readonly kind: 'stop' };

const NONE: readonly AutoPauseEffect[] = [];

export interface AutoPauseObservation {
  /** Uninterrupted silence so far. Desktop dual passes min(mic, system) — see index.ts. */
  readonly silentSeconds: number;
  /** Session length so far, for `minSessionSeconds`. */
  readonly elapsedSeconds: number;
  /** Wall clock, for the renderer-facing countdown deadline only. */
  readonly nowMs: number;
}

export class AutoPauseMachine {
  private phase: AutoPausePhase = 'listening';
  /** When the confirmed pause began (wall clock), for auto-stop. */
  private pausedAtMs: number | null = null;
  /**
   * `silentSeconds` at the moment the grace surface went up. The countdown is measured FROM here,
   * not from the absolute threshold: `enabled` can flip true mid-session (the org query resolving
   * is the normal startup path) with a large silent run already accumulated, and comparing against
   * `silenceSeconds + graceSeconds` would then show the card and commit the pause on the very next
   * frame — destroying the one property the design leans on, that a false positive costs a
   * dismissed card rather than lost audio.
   */
  private graceAnchorS: number | null = null;
  /**
   * The user told us we were wrong. A FLAG, not a phase: it has to survive everything else the
   * session does. As a phase it was silently cleared by the very next dock pause → resume, so a
   * deliberate "Keep recording" bought about five minutes of quiet before the prompt returned —
   * the exact "fighting people" outcome the suppression exists to prevent.
   */
  private suppressed = false;

  constructor(private config: AutoPauseConfig) {}

  get state(): AutoPausePhase {
    return this.phase;
  }

  /** True once the user has told us to stop guessing for this session. */
  get isSuppressed(): boolean {
    return this.suppressed;
  }

  /** Live config swap (an org flag or knob can change between sessions, not mid-decision). */
  configure(config: AutoPauseConfig): void {
    this.config = config;
  }

  /**
   * Feed the current silence/elapsed figures. Call once per captured frame (cheap: a couple of
   * comparisons). Returns the effects to perform, in order.
   */
  observe({ silentSeconds, elapsedSeconds, nowMs }: AutoPauseObservation): readonly AutoPauseEffect[] {
    const { enabled, silenceSeconds, graceSeconds, minSessionSeconds } = this.config;
    if (!enabled) {
      // Turning the gate off mid-grace must retract the surface, not strand it. Without this the
      // card hangs on screen forever: `observe` returns early on every subsequent frame, so the
      // machine can neither hide it nor commit. Reachable on web — the org query has a 5-minute
      // staleTime and a refetch that transiently resolves no matching org flips this false.
      if (this.phase === 'grace') {
        this.phase = 'listening';
        this.graceAnchorS = null;
        return [{ kind: 'hide-grace' }];
      }
      return NONE;
    }
    // A caller that combines lanes itself (desktop MAIN) could hand us a non-finite figure; NaN
    // fails every `<` comparison below, which would raise the surface on the first frame and then
    // strand it in grace forever.
    if (!Number.isFinite(silentSeconds) || !Number.isFinite(elapsedSeconds)) return NONE;
    if (this.suppressed) return NONE;
    // 'committing' / 'paused' / 'suppressed' / 'stopped' are all inert to frames: either we're
    // waiting on the caller, already paused, or the user has told us to stop guessing.
    if (this.phase === 'listening') {
      if (elapsedSeconds < minSessionSeconds) return NONE;
      if (silentSeconds < silenceSeconds) return NONE;
      this.phase = 'grace';
      this.graceAnchorS = silentSeconds;
      const graceMs = graceSeconds * 1000;
      return [{ kind: 'show-grace', graceMs, deadlineMs: nowMs + graceMs }];
    }
    if (this.phase === 'grace') {
      // Speech came back while the card was up — the user is present and never had to touch it.
      if (silentSeconds < silenceSeconds) {
        this.phase = 'listening';
        this.graceAnchorS = null;
        return [{ kind: 'hide-grace' }];
      }
      if (silentSeconds >= (this.graceAnchorS ?? silenceSeconds) + graceSeconds) {
        this.phase = 'committing';
        this.graceAnchorS = null;
        return [{ kind: 'hide-grace' }, { kind: 'pause', attributed: 'silence' }];
      }
    }
    return NONE;
  }

  /**
   * The ASR returned text (the two-signal rule's second half) — cancels a pending grace even if
   * the energy gate still reads silent. The caller also resets its `SilenceWatcher`.
   */
  speechTranscribed(): readonly AutoPauseEffect[] {
    if (this.phase !== 'grace') return NONE;
    this.phase = 'listening';
    return [{ kind: 'hide-grace' }];
  }

  /**
   * Any interaction except the explicit Pause. Suppresses auto-pause for the REST OF THE SESSION:
   * two minutes later the user would still be there, and asking again is how a feature earns a
   * reputation for fighting people.
   */
  keepRecording(): readonly AutoPauseEffect[] {
    if (this.phase === 'stopped') return NONE;
    // Deliberately reachable from 'committing' too: the countdown lapses on a frame boundary
    // (~8ms), so a click can land a hair after the pause was emitted. We cannot un-emit it, but we
    // can make sure this session never asks again.
    this.suppressed = true;
    const wasShowing = this.phase === 'grace';
    if (this.phase === 'grace') this.phase = 'listening';
    this.graceAnchorS = null;
    return wasShowing ? [{ kind: 'hide-grace' }] : NONE;
  }

  /** The explicit Pause button on the grace surface — a consented, user-attributed pause. */
  pauseNow(): readonly AutoPauseEffect[] {
    if (this.phase !== 'grace') return NONE;
    this.phase = 'committing';
    return [{ kind: 'hide-grace' }, { kind: 'pause', attributed: 'user' }];
  }

  /**
   * A pause took effect — ours or the user's own dock button. Starts the auto-stop clock either
   * way: a session the user paused and then abandoned deserves to be finalized into a real note
   * just as much as one we paused.
   */
  notePaused(nowMs: number): readonly AutoPauseEffect[] {
    if (this.phase === 'stopped') return NONE;
    // Note: a suppressed session still starts the auto-stop clock. Suppression is about not asking
    // again, not about abandoning a paused recording to sit open forever.
    // A user hitting the dock's Pause button while the "Still there?" card is up must take the
    // card down with it — `observe` is inert once paused, so nothing else ever would.
    const wasShowing = this.phase === 'grace';
    this.phase = 'paused';
    this.graceAnchorS = null;
    this.pausedAtMs = nowMs;
    return wasShowing ? [{ kind: 'hide-grace' }] : NONE;
  }

  /**
   * The pause we asked for did NOT take effect (`pause()` resolved false — e.g. the AudioContext
   * refused to suspend). Rearm rather than hanging in 'committing' forever; the caller resets its
   * watcher so the next attempt needs a fresh full threshold instead of firing immediately.
   */
  notePauseFailed(): void {
    if (this.phase === 'committing') {
      this.phase = 'listening';
      this.graceAnchorS = null;
    }
  }

  /** Resumed — including a resume that follows an auto-pause. Suppression is NOT cleared here. */
  noteResumed(): void {
    // CALLER CONTRACT: reset the SilenceWatcher too. The silent run that caused the pause is still
    // sitting in it, so without a reset the very next frame re-crosses the threshold and the user
    // is asked again seconds after coming back.
    if (this.phase === 'paused' || this.phase === 'committing') this.phase = 'listening';
    this.graceAnchorS = null;
    this.pausedAtMs = null;
  }

  /**
   * Wall-clock tick while paused; the only place auto-stop can fire (no frames flow while paused,
   * so the sample clock is frozen). Returns `stop` exactly once.
   */
  tick(nowMs: number): readonly AutoPauseEffect[] {
    const { enabled, autoStopAfterPausedMinutes } = this.config;
    if (!enabled || autoStopAfterPausedMinutes <= 0) return NONE;
    if (this.phase !== 'paused' || this.pausedAtMs === null) return NONE;
    if (nowMs - this.pausedAtMs < autoStopAfterPausedMinutes * 60_000) return NONE;
    this.phase = 'stopped';
    this.pausedAtMs = null;
    return [{ kind: 'stop' }];
  }

  /** The session ended (user stopped, or auto-stop completed). Terminal. */
  noteStopped(): readonly AutoPauseEffect[] {
    const wasShowing = this.phase === 'grace';
    this.phase = 'stopped';
    this.graceAnchorS = null;
    this.pausedAtMs = null;
    return wasShowing ? [{ kind: 'hide-grace' }] : NONE;
  }
}
