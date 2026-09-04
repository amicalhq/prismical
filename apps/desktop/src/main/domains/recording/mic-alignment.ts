import type { MicCaptureEvent } from './capture/service';
import {
  findKnownMeetingApp,
  getKnownMeetingApps,
} from '../../infra/mic-detector/known-meeting-apps';

export type MicSource = 'meeting-app' | 'system-default' | 'unavailable';

export type DesiredMicBinding =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'device';
      readonly uid: string;
      readonly appBundleId: string;
      readonly appName: string;
    };

export interface AlignmentSnapshot {
  readonly timestampMs?: number;
  readonly apps: readonly {
    readonly bundleId: string;
    readonly pid: number;
    readonly inputDevices?: readonly { readonly uid: string; readonly name: string }[];
  }[];
}

export interface MicAlignmentState {
  readonly desired: DesiredMicBinding;
  readonly desiredRevision: number;
  readonly actualUid: string | null;
  readonly followedAppBundleId: string | null;
  readonly micSource: MicSource;
  readonly firstSeenAt: ReadonlyMap<string, number>;
  readonly failedUntil: ReadonlyMap<string, number>;
  readonly failedAbsentUids: ReadonlySet<string>;
}

export type MicAlignmentEvent =
  | { readonly _tag: 'snapshot'; readonly snapshot: AlignmentSnapshot }
  | { readonly _tag: 'helper'; readonly event: MicCaptureEvent };

export const FAILED_DEVICE_COOLDOWN_MS = 10_000;

interface Candidate {
  readonly bundleId: string;
  readonly displayName: string;
  readonly uid: string;
  readonly firstSeenAt: number;
  readonly registryIndex: number;
}

const processKey = (bundleId: string, pid: number): string => `${bundleId.toLowerCase()}:${pid}`;

const candidatesFor = (
  state: Pick<MicAlignmentState, 'firstSeenAt' | 'failedUntil' | 'failedAbsentUids'>,
  snapshot: AlignmentSnapshot,
  nowMs: number,
): {
  readonly candidates: readonly Candidate[];
  readonly firstSeenAt: ReadonlyMap<string, number>;
  readonly failedUntil: ReadonlyMap<string, number>;
  readonly failedAbsentUids: ReadonlySet<string>;
} => {
  const registryOrder = new Map(
    getKnownMeetingApps().map((app, index) => [app.bundleId, index] as const),
  );
  const firstSeenAt = new Map<string, number>();
  const observedUids = new Set<string>();
  const grouped = new Map<
    string,
    {
      displayName: string;
      devices: Map<string, string>;
      firstSeenAt: number;
      hasUnresolvedInput: boolean;
    }
  >();

  for (const active of snapshot.apps) {
    const known = findKnownMeetingApp(active.bundleId);
    if (!known?.enabledByDefault) continue;
    const key = processKey(known.bundleId, active.pid);
    const seenAt = state.firstSeenAt.get(key) ?? nowMs;
    firstSeenAt.set(key, seenAt);
    const group = grouped.get(known.bundleId) ?? {
      displayName: known.displayName,
      devices: new Map<string, string>(),
      firstSeenAt: seenAt,
      hasUnresolvedInput: false,
    };
    group.firstSeenAt = Math.min(group.firstSeenAt, seenAt);
    if (active.inputDevices === undefined) {
      group.hasUnresolvedInput = true;
    } else {
      for (const device of active.inputDevices) {
        if (!device.uid) continue;
        group.devices.set(device.uid, device.name);
        observedUids.add(device.uid);
      }
    }
    grouped.set(known.bundleId, group);
  }

  const failedUntil = new Map(state.failedUntil);
  const failedAbsentUids = new Set(state.failedAbsentUids);
  for (const [uid, until] of failedUntil) {
    if (until <= nowMs) {
      failedAbsentUids.delete(uid);
    } else if (!observedUids.has(uid)) {
      failedAbsentUids.add(uid);
    } else if (failedAbsentUids.delete(uid)) {
      failedUntil.delete(uid);
    }
  }

  const candidates: Candidate[] = [];
  for (const [bundleId, group] of grouped) {
    if (group.hasUnresolvedInput || group.devices.size !== 1) continue;
    const uid = group.devices.keys().next().value as string;
    if ((failedUntil.get(uid) ?? 0) > nowMs) continue;
    candidates.push({
      bundleId,
      displayName: group.displayName,
      uid,
      firstSeenAt: group.firstSeenAt,
      registryIndex: registryOrder.get(bundleId) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  candidates.sort(
    (left, right) =>
      left.firstSeenAt - right.firstSeenAt || left.registryIndex - right.registryIndex,
  );
  return { candidates, firstSeenAt, failedUntil, failedAbsentUids };
};

const selectCandidate = (
  state: MicAlignmentState,
  candidate: Candidate,
  firstSeenAt: ReadonlyMap<string, number>,
): MicAlignmentState => ({
  ...state,
  desired: {
    kind: 'device',
    uid: candidate.uid,
    appBundleId: candidate.bundleId,
    appName: candidate.displayName,
  },
  followedAppBundleId: candidate.bundleId,
  micSource: state.micSource === 'unavailable' ? 'unavailable' : 'meeting-app',
  firstSeenAt,
});

const reduceSnapshot = (
  state: MicAlignmentState,
  snapshot: AlignmentSnapshot,
  nowMs: number,
): MicAlignmentState => {
  const { candidates, firstSeenAt, failedUntil, failedAbsentUids } = candidatesFor(
    state,
    snapshot,
    nowMs,
  );
  const snapshotState = { ...state, firstSeenAt, failedUntil, failedAbsentUids };
  const followed =
    state.followedAppBundleId === null
      ? undefined
      : candidates.find(candidate => candidate.bundleId === state.followedAppBundleId);

  if (followed) return selectCandidate(snapshotState, followed, firstSeenAt);

  // Loss or ambiguity is not a reason to jump back to default. The current
  // device remains pinned, but another positive, identifiable app signal may
  // take ownership of the session.
  const withoutFollowed = { ...snapshotState, followedAppBundleId: null };
  const next = candidates[0];
  return next ? selectCandidate(withoutFollowed, next, firstSeenAt) : withoutFollowed;
};

const coolDown = (
  state: MicAlignmentState,
  uid: string,
  nowMs: number,
): MicAlignmentState => {
  const failedUntil = new Map(state.failedUntil);
  failedUntil.set(uid, nowMs + FAILED_DEVICE_COOLDOWN_MS);
  const failedAbsentUids = new Set(state.failedAbsentUids);
  failedAbsentUids.delete(uid);
  return {
    ...state,
    desired: { kind: 'default' },
    followedAppBundleId: null,
    micSource: state.micSource === 'unavailable' ? 'unavailable' : 'system-default',
    failedUntil,
    failedAbsentUids,
  };
};

const reduceHelper = (
  state: MicAlignmentState,
  event: MicCaptureEvent,
  nowMs: number,
): MicAlignmentState => {
  const affectsDesired = event.rev === undefined || event.rev === state.desiredRevision;
  switch (event.kind) {
    case 'bound': {
      if (event.rev !== undefined && event.rev < state.desiredRevision) return state;
      const autonomous = event.reason === 'autonomous-fallback';
      const adopted =
        autonomous && affectsDesired && state.desired.kind === 'device'
          ? coolDown(state, state.desired.uid, nowMs)
          : state;
      const meetingApp = adopted.desired.kind === 'device' && adopted.desired.uid === event.uid;
      return {
        ...adopted,
        actualUid: event.uid,
        micSource: meetingApp ? 'meeting-app' : 'system-default',
      };
    }
    case 'lost': {
      const lost = state.actualUid === event.uid ? { ...state, actualUid: null } : state;
      return affectsDesired && lost.desired.kind === 'device' && lost.desired.uid === event.uid
        ? coolDown(lost, event.uid, nowMs)
        : lost;
    }
    case 'bind-failed':
      return affectsDesired && state.desired.kind === 'device' && state.desired.uid === event.uid
        ? coolDown(state, event.uid, nowMs)
        : state;
    case 'unavailable':
      return { ...state, actualUid: null, micSource: 'unavailable' };
    case 'recovered': {
      const actualUid = event.uid ?? state.actualUid;
      return {
        ...state,
        actualUid,
        micSource:
          state.desired.kind === 'device' && state.desired.uid === actualUid
            ? 'meeting-app'
            : 'system-default',
      };
    }
    case 'timeline-jump':
      return state;
  }
};

export const initialMicAlignmentState = (
  snapshot: AlignmentSnapshot | null,
  nowMs: number,
): MicAlignmentState => {
  const base: MicAlignmentState = {
    desired: { kind: 'default' },
    desiredRevision: 0,
    actualUid: null,
    followedAppBundleId: null,
    micSource: 'system-default',
    firstSeenAt: new Map(),
    failedUntil: new Map(),
    failedAbsentUids: new Set(),
  };
  return snapshot ? reduceSnapshot(base, snapshot, nowMs) : base;
};

export const reduceMicAlignment = (
  state: MicAlignmentState,
  event: MicAlignmentEvent,
  nowMs: number,
): MicAlignmentState => {
  const next = event._tag === 'snapshot'
    ? reduceSnapshot(state, event.snapshot, nowMs)
    : reduceHelper(state, event.event, nowMs);
  return sameDesiredBinding(state.desired, next.desired)
    ? next
    : { ...next, desiredRevision: state.desiredRevision + 1 };
};

export const sameDesiredBinding = (
  left: DesiredMicBinding,
  right: DesiredMicBinding,
): boolean =>
  left.kind === right.kind &&
  (left.kind === 'default' || (right.kind === 'device' && left.uid === right.uid));
