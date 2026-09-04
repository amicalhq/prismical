/**
 * Meeting-detection reducer tests — the pure policy.
 *
 * No Clock, no fibers, no processes: the reducer is `(state, event, nowMs) →
 * state`, so every timeline (sustained activity, blips, cooldowns, suppression,
 * priority ties) is replayed by hand with explicit `nowMs`. The DetectionService
 * test (detection-service.test.ts) covers the same policy end-to-end under
 * TestClock + a fake mic-detector child.
 */
import { describe, expect, it } from 'vitest';
import type { MicActivitySnapshotEvent } from '@/types/meeting-start-notifications';
import {
  COOLDOWN_MS,
  DETECTION_DELAY_MS,
  initialReducerState,
  project,
  reduce,
  type DetectionEvent,
  type DetectionReducerState,
} from '../../src/main/domains/detection/policy';

const ZOOM = 'us.zoom.xos';
const CHROME = 'com.google.Chrome';
const BRAVE = 'com.brave.Browser';
const TEAMS = 'com.microsoft.teams2';
const UNKNOWN = 'com.apple.Music'; // not in the meeting-apps matrix → weight 0

const snap = (bundleIds: string[], now: number): DetectionEvent => ({
  _tag: 'snapshot',
  snapshot: {
    timestampMs: now,
    apps: bundleIds.map(bundleId => ({ bundleId, pid: 1, detectedAtMs: now })),
  } satisfies MicActivitySnapshotEvent,
});

/** Fold a scripted [event, nowMs] timeline from the initial state. */
const run = (steps: Array<[DetectionEvent, number]>): DetectionReducerState =>
  steps.reduce((state, [event, now]) => reduce(state, event, now), initialReducerState);

describe('detection policy reducer: delay, cooldown, suppression, and weighting', () => {
  it('declares detected only AFTER the sustained-activity delay, not before', () => {
    // Zoom holds the mic continuously; it must not fire until 4 s have elapsed.
    const before = run([
      [snap([ZOOM], 0), 0],
      [snap([ZOOM], DETECTION_DELAY_MS - 1), DETECTION_DELAY_MS - 1],
    ]);
    expect(project(before).status).toBe('idle');

    const after = reduce(before, snap([ZOOM], DETECTION_DELAY_MS), DETECTION_DELAY_MS);
    const state = project(after);
    expect(state.status).toBe('detected');
    expect(state.detection?.bundleId).toBe(ZOOM);
    expect(state.detection?.displayName).toBe('Zoom');
    expect(state.detection?.weight).toBe(100);
    expect(state.detection?.confidence).toBe(1);
    expect(state.detection?.since).toBe(0); // sustained run began at t0
  });

  it('a blip shorter than the delay stays idle (the run resets when the app lapses)', () => {
    const state = run([
      [snap([ZOOM], 0), 0], // Zoom appears
      [snap([], 1_000), 1_000], // ...and is gone one frame later (a 1 s blip)
      [snap([ZOOM], 5_000), 5_000], // reappears — its run restarts at 5 s, delay NOT met
    ]);
    expect(project(state).status).toBe('idle');
  });

  it('an unknown / sub-threshold app never crosses the confidence floor', () => {
    const state = run([
      [snap([UNKNOWN], 0), 0],
      [snap([UNKNOWN], 10_000), 10_000], // long past the delay — still nothing
      [snap([UNKNOWN], 60_000), 60_000],
    ]);
    expect(project(state).status).toBe('idle');
    expect(state.active.size).toBe(0); // never even tracked
  });

  it('weights the highest-priority app when several meeting apps are sustained', () => {
    const state = run([
      [snap([CHROME, ZOOM, TEAMS], 0), 0],
      [snap([CHROME, ZOOM, TEAMS], 5_000), 5_000],
    ]);
    expect(project(state).detection?.bundleId).toBe(ZOOM); // 100 > Teams 95 > Chrome 60
  });

  it('breaks a same-weight tie by whichever app started first', () => {
    const state = run([
      [snap([CHROME], 0), 0], // Chrome first (weight 60)
      [snap([CHROME, BRAVE], 1_000), 1_000], // Brave joins later (also 60)
      [snap([CHROME, BRAVE], 6_000), 6_000], // both past the delay now
    ]);
    expect(project(state).detection?.bundleId).toBe(CHROME); // earlier firstDetectedAt wins
  });

  it('is sticky: once detected, the same app keeps a stable since/detectedAt', () => {
    const first = reduce(
      run([[snap([ZOOM], 0), 0]]),
      snap([ZOOM], 5_000),
      5_000,
    );
    expect(first.detection?.detectedAt).toBe(5_000);
    const later = reduce(first, snap([ZOOM], 9_000), 9_000);
    // Same detection object — no flicker, detectedAt does not jump to 9 s.
    expect(later.detection).toBe(first.detection);
    expect(later.detection?.detectedAt).toBe(5_000);
  });

  it('dismiss cools the app down for ~5 min, then it can fire again', () => {
    const detected = reduce(run([[snap([ZOOM], 0), 0]]), snap([ZOOM], 5_000), 5_000);
    expect(project(detected).status).toBe('detected');

    const dismissed = reduce(detected, { _tag: 'dismiss' }, 5_000);
    expect(project(dismissed).status).toBe('idle');

    // Still in the cooldown window (Zoom keeps holding the mic) → stays idle.
    const during = reduce(dismissed, snap([ZOOM], 6_000), 6_000);
    expect(project(during).status).toBe('idle');

    // Just before the cooldown lifts → idle; just after → detected again.
    const justBefore = reduce(during, snap([ZOOM], 5_000 + COOLDOWN_MS - 1), 5_000 + COOLDOWN_MS - 1);
    expect(project(justBefore).status).toBe('idle');
    const justAfter = reduce(justBefore, snap([ZOOM], 5_000 + COOLDOWN_MS + 1), 5_000 + COOLDOWN_MS + 1);
    expect(project(justAfter).status).toBe('detected');
  });

  it('dismiss is a no-op when nothing is detected', () => {
    const state = reduce(initialReducerState, { _tag: 'dismiss' }, 1_000);
    expect(state).toBe(initialReducerState);
  });

  it('an active recording suppresses detection; stopping cools down the active apps', () => {
    const detected = reduce(run([[snap([ZOOM], 0), 0]]), snap([ZOOM], 5_000), 5_000);
    expect(project(detected).status).toBe('detected');

    // Recording starts (for this meeting) → pill suppressed.
    const recording = reduce(detected, { _tag: 'recordingActive', active: true }, 5_000);
    expect(project(recording).status).toBe('idle');
    // Snapshots keep arriving during the recording but never re-detect.
    const midRecording = reduce(recording, snap([ZOOM], 6_000), 6_000);
    expect(project(midRecording).status).toBe('idle');

    // Recording stops → the still-ongoing Zoom is cooled down (no instant re-prompt).
    const stopped = reduce(midRecording, { _tag: 'recordingActive', active: false }, 7_000);
    expect(project(stopped).status).toBe('idle');
    const afterStop = reduce(stopped, snap([ZOOM], 8_000), 8_000);
    expect(project(afterStop).status).toBe('idle');

    // Once the post-stop cooldown lifts, it may fire again.
    const later = reduce(afterStop, snap([ZOOM], 7_000 + COOLDOWN_MS + 1), 7_000 + COOLDOWN_MS + 1);
    expect(project(later).status).toBe('detected');
  });

  it('clears a live detection the moment a recording becomes active', () => {
    const detected = reduce(run([[snap([ZOOM], 0), 0]]), snap([ZOOM], 5_000), 5_000);
    const recording = reduce(detected, { _tag: 'recordingActive', active: true }, 5_100);
    expect(recording.detection).toBeNull();
    expect(recording.recordingActive).toBe(true);
  });
});
