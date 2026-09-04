/**
 * Meeting-detection policy — a PURE, Clock-agnostic reducer.
 *
 * Folds mic-activity snapshots (which app/process is using the microphone, 1 Hz
 * from the native mic-detector) + user/record commands into a `DetectionState`
 * that answers one question: "is a meeting happening right now, and should we
 * offer to take notes?". The heuristic uses an app-weighting matrix, a
 * sustained-activity delay, a per-app
 * cooldown, suppression reasons) into a single pure function so it is exhaustively
 * unit-testable and reads no wall clock: every
 * transition takes `nowMs` as a parameter. The DetectionService (live.ts) is the
 * only caller and supplies `nowMs` from `Clock.currentTimeMillis`, so TestClock
 * drives the delay + cooldown in tests.
 *
 * It deliberately never starts a recording. It only exposes `status: 'detected'`
 * + the detected app; the pill reads that, and the user confirms "Take notes"
 * → RecordingService.start. Suppression while a
 * recording is active, and a cooldown after one stops, keep it from offering to
 * record what is already being recorded.
 */
import type {
  KnownMeetingApp,
  KnownMeetingAppCategory,
  MicActivitySnapshotEvent,
} from '@/types/meeting-start-notifications';
import { findKnownMeetingApp } from '../../infra/mic-detector/known-meeting-apps';

/**
 * Sustained mic-activity required before a meeting app is declared 'detected'.
 * A meeting app must hold the mic continuously for this long (measured on the
 * Clock, not the app's self-reported timestamp) so a transient blip — a browser
 * tab that grabbed the mic for a second, a notification chime — never fires.
 */
export const DETECTION_DELAY_MS = 4_000;

/**
 * After the user dismisses the pill, or stops a recording, don't re-offer the
 * same app for this long. Keyed per bundle id, so
 * dismissing Zoom won't re-nag you about the same Zoom call, but a different app
 * starting a meeting still fires immediately.
 */
export const COOLDOWN_MS = 300_000; // 5 min

/**
 * Confidence floor. `weightFor` maps an app to its known-app priority (Zoom 100
 * … browsers 55–60) or 0 for anything not in the meeting-apps matrix. Only apps
 * at or above this floor can trigger detection — so an unknown/low-weight mic
 * user (a music app, a system chime) never produces a pill. Every app in the
 * current matrix (min 55) clears it; the floor exists so the matrix can carry
 * lower-confidence entries in future without them auto-firing.
 */
export const MIN_DETECTION_WEIGHT = 50;

/** A known meeting app currently holding the mic, with when it started/last seen. */
export interface TrackedApp {
  readonly app: KnownMeetingApp;
  /** Clock time the app began this continuous run of mic activity. */
  readonly firstDetectedAtMs: number;
  /** Clock time of the most recent snapshot that still showed it active. */
  readonly lastDetectedAtMs: number;
}

/** The detected meeting the widget pill renders + the record flow may act on. */
export interface DetectedMeeting {
  readonly bundleId: string;
  readonly displayName: string;
  readonly category: KnownMeetingAppCategory;
  /** The app's known-app priority (Zoom 100 … browsers 60). */
  readonly weight: number;
  /** `weight` normalised to 0..1 for the UI. */
  readonly confidence: number;
  /** Clock time sustained mic activity began (the pill's "since"). */
  readonly since: number;
  /** Clock time it crossed the sustained-activity delay → 'detected'. */
  readonly detectedAt: number;
}

export type DetectionStatus = 'idle' | 'detected';

/**
 * The observable projection that the widget reads (a SubscriptionRef in the
 * service). Intentionally minimal — the internal bookkeeping (active apps,
 * cooldowns) stays in `DetectionReducerState` and never reaches the renderer.
 */
export interface DetectionState {
  readonly status: DetectionStatus;
  readonly detection: DetectedMeeting | null;
}

export const idleDetectionState: DetectionState = {
  status: 'idle',
  detection: null,
};

/** Full reducer state (service-internal): tracked apps, cooldowns, suppression. */
export interface DetectionReducerState {
  /** Known meeting apps currently using the mic (canonical bundle id → run). */
  readonly active: ReadonlyMap<string, TrackedApp>;
  /** Per-app cooldown expiry (bundle id → Clock time the cooldown lifts). */
  readonly cooldownUntil: ReadonlyMap<string, number>;
  /** A recording is in flight → detection is fully suppressed. */
  readonly recordingActive: boolean;
  /** The current 'detected' meeting (sticky until it lapses), or null. */
  readonly detection: DetectedMeeting | null;
}

export const initialReducerState: DetectionReducerState = {
  active: new Map(),
  cooldownUntil: new Map(),
  recordingActive: false,
  detection: null,
};

/**
 * Reducer inputs. `snapshot` is the 1 Hz mic-detector frame; `dismiss` is the
 * pill's X (per-app cooldown); `recordingActive` is derived from RecordingService
 * state (true suppresses detection; the true→false edge cools down every
 * currently-active app so a just-stopped meeting doesn't immediately re-prompt).
 */
export type DetectionEvent =
  | { readonly _tag: 'snapshot'; readonly snapshot: MicActivitySnapshotEvent }
  | { readonly _tag: 'dismiss' }
  | { readonly _tag: 'recordingActive'; readonly active: boolean };

const weightFor = (app: KnownMeetingApp): number => app.priority ?? 0;

/** Project the internal state to the observable the widget reads. */
export const project = (state: DetectionReducerState): DetectionState =>
  state.detection === null
    ? idleDetectionState
    : { status: 'detected', detection: state.detection };

const toDetected = (tracked: TrackedApp, nowMs: number): DetectedMeeting => {
  const weight = weightFor(tracked.app);
  return {
    bundleId: tracked.app.bundleId,
    displayName: tracked.app.displayName,
    category: tracked.app.category,
    weight,
    confidence: Math.min(1, weight / 100),
    since: tracked.firstDetectedAtMs,
    detectedAt: nowMs,
  };
};

/** Can this tracked app trigger (or hold) a detection right now? */
const qualifies = (
  tracked: TrackedApp,
  state: DetectionReducerState,
  nowMs: number,
): boolean => {
  if (state.recordingActive) return false;
  if (weightFor(tracked.app) < MIN_DETECTION_WEIGHT) return false;
  const cooldown = state.cooldownUntil.get(tracked.app.bundleId) ?? 0;
  if (cooldown > nowMs) return false;
  return nowMs - tracked.firstDetectedAtMs >= DETECTION_DELAY_MS;
};

/**
 * Choose the detection. Sticky: if the current detection's app is still active
 * and still qualifies, keep the SAME `DetectedMeeting` (stable `since`/
 * `detectedAt`, no flicker). Otherwise pick the best fresh candidate — highest
 * weight, ties broken by who started first — or null if none qualifies.
 */
const pickDetection = (
  state: DetectionReducerState,
  nowMs: number,
): DetectedMeeting | null => {
  if (state.recordingActive) return null;

  if (state.detection !== null) {
    const current = state.active.get(state.detection.bundleId);
    if (current !== undefined && qualifies(current, state, nowMs)) {
      return state.detection;
    }
  }

  const best = [...state.active.values()]
    .filter(tracked => qualifies(tracked, state, nowMs))
    .sort(
      (left, right) =>
        weightFor(right.app) - weightFor(left.app) ||
        left.firstDetectedAtMs - right.firstDetectedAtMs,
    )[0];

  return best === undefined ? null : toDetected(best, nowMs);
};

const reduceSnapshot = (
  state: DetectionReducerState,
  snapshot: MicActivitySnapshotEvent,
  nowMs: number,
): DetectionReducerState => {
  // Canonical known apps in this frame (aliases + sub-threshold weights collapse
  // out here, so `active` only ever holds trigger-eligible meeting apps).
  const seen = new Map<string, KnownMeetingApp>();
  for (const activeApp of snapshot.apps) {
    const known = findKnownMeetingApp(activeApp.bundleId);
    if (known === undefined) continue;
    if (weightFor(known) < MIN_DETECTION_WEIGHT) continue;
    if (!seen.has(known.bundleId)) seen.set(known.bundleId, known);
  }

  // Keep `firstDetectedAtMs` for apps still present (continuous run), start a
  // fresh run for newcomers. Apps absent from this frame are dropped — so a run
  // that lapses even for one 1 Hz frame resets its delay when it returns (that
  // is what makes a sub-delay blip stay idle).
  const active = new Map<string, TrackedApp>();
  for (const [bundleId, app] of seen) {
    const prev = state.active.get(bundleId);
    active.set(bundleId, {
      app,
      firstDetectedAtMs: prev?.firstDetectedAtMs ?? nowMs,
      lastDetectedAtMs: nowMs,
    });
  }

  const next: DetectionReducerState = { ...state, active };
  return { ...next, detection: pickDetection(next, nowMs) };
};

const reduceDismiss = (
  state: DetectionReducerState,
  nowMs: number,
): DetectionReducerState => {
  if (state.detection === null) return state;
  const cooldownUntil = new Map(state.cooldownUntil);
  cooldownUntil.set(state.detection.bundleId, nowMs + COOLDOWN_MS);
  return { ...state, cooldownUntil, detection: null };
};

const reduceRecordingActive = (
  state: DetectionReducerState,
  active: boolean,
  nowMs: number,
): DetectionReducerState => {
  if (active === state.recordingActive) return state;
  if (active) {
    // A recording started (possibly for the very meeting we detected): suppress
    // the pill entirely — the widget swaps to the recording pill.
    return { ...state, recordingActive: true, detection: null };
  }
  // A recording stopped: cool down every app currently holding the mic, so the
  // just-recorded meeting (still ongoing) doesn't immediately re-prompt.
  const cooldownUntil = new Map(state.cooldownUntil);
  for (const bundleId of state.active.keys()) {
    cooldownUntil.set(bundleId, nowMs + COOLDOWN_MS);
  }
  const next: DetectionReducerState = { ...state, recordingActive: false, cooldownUntil };
  return { ...next, detection: pickDetection(next, nowMs) };
};

/**
 * The pure reducer: `(state, event, nowMs) → state`. No wall-clock reads, no
 * side effects — the entire delay/cooldown/weighting policy is a function of its
 * inputs, so a test can replay any timeline deterministically.
 */
export const reduce = (
  state: DetectionReducerState,
  event: DetectionEvent,
  nowMs: number,
): DetectionReducerState => {
  switch (event._tag) {
    case 'snapshot':
      return reduceSnapshot(state, event.snapshot, nowMs);
    case 'dismiss':
      return reduceDismiss(state, nowMs);
    case 'recordingActive':
      return reduceRecordingActive(state, event.active, nowMs);
  }
};
