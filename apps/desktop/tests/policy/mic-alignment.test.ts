import { describe, expect, it } from 'vitest';
import {
  FAILED_DEVICE_COOLDOWN_MS,
  initialMicAlignmentState,
  reduceMicAlignment,
  type AlignmentSnapshot,
  type MicAlignmentState,
} from '../../src/main/domains/recording/mic-alignment';

const ZOOM = 'us.zoom.xos';
const CHROME = 'com.google.Chrome';
const UNKNOWN = 'com.apple.Music';

const snapshot = (
  apps: Array<{ bundleId: string; pid?: number; devices?: string[] }>,
): AlignmentSnapshot => ({
  apps: apps.map(({ bundleId, pid = 1, devices = [] }) => ({
    bundleId,
    pid,
    inputDevices: devices.map(uid => ({ uid, name: uid })),
  })),
});

const snap = (state: MicAlignmentState, value: AlignmentSnapshot, nowMs = 0) =>
  reduceMicAlignment(state, { _tag: 'snapshot', snapshot: value }, nowMs);

describe('microphone alignment policy', () => {
  it('starts on the live default without identifiable supported context', () => {
    expect(initialMicAlignmentState(null, 0).desired).toEqual({ kind: 'default' });
    expect(
      initialMicAlignmentState(snapshot([{ bundleId: UNKNOWN, devices: ['mic-b'] }]), 0)
        .desired,
    ).toEqual({ kind: 'default' });
    expect(
      initialMicAlignmentState(snapshot([{ bundleId: ZOOM, devices: [] }]), 0).desired,
    ).toEqual({ kind: 'default' });
  });

  it('aligns at start and follows a positive in-app device change', () => {
    const started = initialMicAlignmentState(
      snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]),
      0,
    );
    expect(started.desired).toMatchObject({ kind: 'device', uid: 'mic-b', appBundleId: ZOOM });

    const switched = snap(started, snapshot([{ bundleId: ZOOM, devices: ['mic-c'] }]), 1_000);
    expect(switched.desired).toMatchObject({ kind: 'device', uid: 'mic-c' });
    expect(switched.followedAppBundleId).toBe(ZOOM);
  });

  it('holds the current device when followed-app context disappears or becomes ambiguous', () => {
    const started = initialMicAlignmentState(
      snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]),
      0,
    );
    expect(snap(started, snapshot([]), 1_000).desired).toEqual(started.desired);
    expect(
      snap(started, snapshot([{ bundleId: ZOOM, devices: ['mic-b', 'mic-c'] }]), 1_000)
        .desired,
    ).toEqual(started.desired);
  });

  it('does not identify a canonical app group with an unresolved process input', () => {
    const unresolvedGroup: AlignmentSnapshot = {
      apps: [
        {
          bundleId: ZOOM,
          pid: 1,
          inputDevices: [{ uid: 'mic-b', name: 'mic-b' }],
        },
        { bundleId: 'us.zoom.ZoomHybridConf', pid: 2 },
      ],
    };

    expect(initialMicAlignmentState(unresolvedGroup, 0).desired).toEqual({ kind: 'default' });
  });

  it('retains the followed app and uses longest-active when selecting anew', () => {
    const chromeFirst = initialMicAlignmentState(
      snapshot([{ bundleId: CHROME, devices: ['mic-c'] }]),
      0,
    );
    const zoomJoins = snap(
      chromeFirst,
      snapshot([
        { bundleId: CHROME, devices: ['mic-c'] },
        { bundleId: ZOOM, devices: ['mic-z'] },
      ]),
      1_000,
    );
    expect(zoomJoins.desired).toMatchObject({ kind: 'device', uid: 'mic-c' });

    const zoomOnly = snap(
      zoomJoins,
      snapshot([{ bundleId: ZOOM, devices: ['mic-z'] }]),
      2_000,
    );
    expect(zoomOnly.desired).toMatchObject({ kind: 'device', uid: 'mic-z' });
  });

  it('uses canonical registry order for session-start ties and resets per session', () => {
    const tied = initialMicAlignmentState(
      snapshot([
        { bundleId: ZOOM, devices: ['mic-z'] },
        { bundleId: CHROME, devices: ['mic-c'] },
      ]),
      0,
    );
    expect(tied.desired).toMatchObject({ kind: 'device', uid: 'mic-c' });

    const nextSession = initialMicAlignmentState(null, 1_000);
    expect(nextSession.desired).toEqual({ kind: 'default' });
    expect(nextSession.firstSeenAt.size).toBe(0);
  });

  it('adopts helper fallback immediately and does not reselect the failed uid during cooldown', () => {
    const started = initialMicAlignmentState(
      snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]),
      0,
    );
    const failed = reduceMicAlignment(
      started,
      { _tag: 'helper', event: { kind: 'bind-failed', uid: 'mic-b', rev: 0 } },
      1_000,
    );
    expect(failed.desired).toEqual({ kind: 'default' });
    expect(snap(failed, snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]), 2_000).desired).toEqual({
      kind: 'default',
    });
    expect(
      snap(
        failed,
        snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]),
        1_000 + FAILED_DEVICE_COOLDOWN_MS,
      ).desired,
    ).toMatchObject({ kind: 'device', uid: 'mic-b' });
  });

  it('retries a failed uid when it disappears and reappears during cooldown', () => {
    const started = initialMicAlignmentState(
      snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]),
      0,
    );
    const failed = reduceMicAlignment(
      started,
      { _tag: 'helper', event: { kind: 'bind-failed', uid: 'mic-b', rev: 0 } },
      1_000,
    );
    const absent = snap(failed, snapshot([{ bundleId: ZOOM, devices: [] }]), 2_000);
    const reappeared = snap(
      absent,
      snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]),
      3_000,
    );

    expect(reappeared.desired).toMatchObject({ kind: 'device', uid: 'mic-b' });
  });

  it('surfaces unavailable and recovered state without ending the session', () => {
    const initial = initialMicAlignmentState(null, 0);
    const unavailable = reduceMicAlignment(
      initial,
      { _tag: 'helper', event: { kind: 'unavailable' } },
      100,
    );
    expect(unavailable.micSource).toBe('unavailable');
    const recovered = reduceMicAlignment(
      unavailable,
      { _tag: 'helper', event: { kind: 'recovered', uid: 'mic-a' } },
      200,
    );
    expect(recovered.micSource).toBe('system-default');
    expect(recovered.actualUid).toBe('mic-a');
  });

  it('adopts device loss before fallback, including when no default is available', () => {
    const started = reduceMicAlignment(
      initialMicAlignmentState(snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]), 0),
      {
        _tag: 'helper',
        event: { kind: 'bound', uid: 'mic-b', mode: 'fixed', rev: 0 },
      },
      100,
    );
    const lost = reduceMicAlignment(
      started,
      { _tag: 'helper', event: { kind: 'lost', uid: 'mic-b', rev: 0 } },
      200,
    );
    expect(lost.desired).toEqual({ kind: 'default' });
    expect(lost.actualUid).toBeNull();
    expect(lost.micSource).toBe('system-default');

    const unavailable = reduceMicAlignment(
      lost,
      { _tag: 'helper', event: { kind: 'unavailable', rev: 0 } },
      201,
    );
    expect(unavailable.micSource).toBe('unavailable');
  });

  it('treats an autonomous fallback as actual truth before reconciliation', () => {
    const started = initialMicAlignmentState(
      snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]),
      0,
    );
    const fallback = reduceMicAlignment(
      started,
      {
        _tag: 'helper',
        event: {
          kind: 'bound',
          uid: 'mic-a',
          reason: 'autonomous-fallback',
          rev: 0,
        },
      },
      1_000,
    );
    expect(fallback.desired).toEqual({ kind: 'default' });
    expect(fallback.actualUid).toBe('mic-a');
    expect(fallback.micSource).toBe('system-default');
  });

  it('does not let stale helper outcomes demote a newer desired generation', () => {
    const micB = initialMicAlignmentState(
      snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]),
      0,
    );
    const micC = snap(micB, snapshot([{ bundleId: ZOOM, devices: ['mic-c'] }]), 100);

    expect(micC.desiredRevision).toBe(1);
    expect(
      reduceMicAlignment(
        micC,
        {
          _tag: 'helper',
          event: {
            kind: 'bound',
            uid: 'mic-a',
            reason: 'autonomous-fallback',
            rev: 0,
          },
        },
        200,
      ),
    ).toEqual(micC);

    const micBAgain = snap(micC, snapshot([{ bundleId: ZOOM, devices: ['mic-b'] }]), 300);
    expect(micBAgain.desiredRevision).toBe(2);
    const staleFailure = reduceMicAlignment(
      micBAgain,
      { _tag: 'helper', event: { kind: 'bind-failed', uid: 'mic-b', rev: 0 } },
      400,
    );
    expect(staleFailure.desired).toEqual(micBAgain.desired);
    expect(staleFailure.desiredRevision).toBe(2);
    expect(staleFailure.failedUntil.has('mic-b')).toBe(false);

    const staleLoss = reduceMicAlignment(
      { ...micBAgain, actualUid: 'mic-b' },
      { _tag: 'helper', event: { kind: 'lost', uid: 'mic-b', rev: 0 } },
      500,
    );
    expect(staleLoss.actualUid).toBeNull();
    expect(staleLoss.desired).toEqual(micBAgain.desired);
    expect(staleLoss.desiredRevision).toBe(2);
    expect(staleLoss.failedUntil.has('mic-b')).toBe(false);
  });
});
