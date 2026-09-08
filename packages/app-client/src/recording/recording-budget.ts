"use client";

import * as React from "react";
import type { NativeRecordingState } from "@prismical/app-contracts";
import { usePorts } from "../ports-context";
import { useCloudTranscriptionQuota } from "../api/hooks/usage";
import { useEntitlements } from "../api/hooks/organizations";
import { useModelDefaults } from "../api/hooks/model-defaults";

/**
 * The two budgets a live recording spends, and when to say something about them.
 *
 * A session spends its own length against the plan's per-recording cap; it also spends the
 * organization's monthly Cloud transcription allowance. Either can end the useful part of a
 * recording, and the failure is the same either way: the user finds out afterwards. So both are
 * resolved here, in one pure function, and the dock renders whichever will bite first.
 *
 * Warnings are DELIBERATELY not dismissible-forever. A dismissal hides the notice the user has
 * read; it cannot buy more session or more allowance, so the next, more urgent threshold raises a
 * new one. (The auto-pause prompt takes the opposite rule for a good reason: there, interacting
 * really does resolve the thing it was asking about.)
 */

/** Time-remaining marks on the session cap, most patient first. */
export const SESSION_WARN_THRESHOLDS_SECONDS = [15 * 60, 5 * 60] as const;
/** Time-remaining marks on the monthly allowance. Tighter at the end: the last one is a heads-up
 * that the transcript is about to stop, and two minutes is as late as that can usefully be said. */
export const QUOTA_WARN_THRESHOLDS_SECONDS = [15 * 60, 10 * 60, 2 * 60] as const;

export type RecordingBudgetKind = "session" | "quota";

export interface RecordingBudgetWarning {
  kind: RecordingBudgetKind;
  /** The mark that fired, in seconds — what the copy is keyed on. */
  thresholdSeconds: number;
  /** Seconds of this budget left, floored at 1: a fired warning always has something left. */
  remainingSeconds: number;
  /** Session only: the cap being approached, for copy that names the plan's limit. */
  capSeconds?: number;
}

/** Stable identity for a fired warning, so a dismissal can name exactly what it dismissed. */
export const recordingBudgetWarningKey = (warning: RecordingBudgetWarning): string =>
  `${warning.kind}:${warning.thresholdSeconds}`;

export interface RecordingBudgetInput {
  /** A session is live. Paused counts: a pause suspends spending, it does not end the session. */
  isRecording: boolean;
  /** Running seconds banked by this session — paused time is not spent time. */
  elapsedSeconds: number;
  /** Plan cap, or null when the client knows of none. */
  maxRecordingSeconds: number | null;
  /**
   * Allowance left when this session STARTED, not right now: `/me/usage` is cached and is not
   * re-fetched mid-recording, so the live figure has to be projected from the session's own
   * elapsed seconds. Re-latching it mid-session would double-count — the refetched figure already
   * includes the seconds this session has metered, which `elapsedSeconds` then subtracts again.
   * null when the plan is unmetered, the transcription runs on the owner's own key, or the usage
   * response has not arrived.
   */
  quotaRemainingAtStartSeconds: number | null;
  /** Warning keys the user has already dismissed during this session. */
  dismissed: readonly string[];
}

/** The most urgent mark at or below `remaining`, or null when none has been reached yet. */
function firedThreshold(
  remaining: number,
  thresholds: readonly number[],
): number | null {
  if (remaining <= 0) return null; // spent: a warning is no longer a warning
  let fired: number | null = null;
  for (const threshold of thresholds) {
    if (remaining <= threshold && (fired === null || threshold < fired)) fired = threshold;
  }
  return fired;
}

/**
 * Pure. Returns the one notice worth showing, or null.
 *
 * When both budgets have fired, the one with less left wins: it is the one that will actually end
 * the recording, and stacking two cards over a dock during a meeting helps nobody.
 */
export function resolveRecordingBudgetWarning(
  input: RecordingBudgetInput,
): RecordingBudgetWarning | null {
  if (!input.isRecording) return null;

  const candidates: RecordingBudgetWarning[] = [];

  if (input.maxRecordingSeconds !== null) {
    const remaining = input.maxRecordingSeconds - input.elapsedSeconds;
    const threshold = firedThreshold(remaining, SESSION_WARN_THRESHOLDS_SECONDS);
    if (threshold !== null) {
      candidates.push({
        kind: "session",
        thresholdSeconds: threshold,
        remainingSeconds: remaining,
        capSeconds: input.maxRecordingSeconds,
      });
    }
  }

  if (input.quotaRemainingAtStartSeconds !== null) {
    const remaining = input.quotaRemainingAtStartSeconds - input.elapsedSeconds;
    const threshold = firedThreshold(remaining, QUOTA_WARN_THRESHOLDS_SECONDS);
    if (threshold !== null) {
      candidates.push({ kind: "quota", thresholdSeconds: threshold, remainingSeconds: remaining });
    }
  }

  const winner = candidates.reduce<RecordingBudgetWarning | null>(
    (best, next) => (best === null || next.remainingSeconds < best.remainingSeconds ? next : best),
    null,
  );
  if (winner === null) return null;
  return input.dismissed.includes(recordingBudgetWarningKey(winner)) ? null : winner;
}

/**
 * The live warning for the dock.
 *
 * Per-session state is keyed on the RECORDING's id, not on "is a recording running": a pause is
 * still the same session, and resetting on pause would re-latch the allowance against seconds this
 * session has already spent (double-counting them) and resurrect warnings the user dismissed.
 */
export function useRecordingBudgetWarning(opts: {
  /** The live session's recording id, or null when nothing is being recorded. */
  sessionId: string | null;
  elapsedSeconds: number;
}): { warning: RecordingBudgetWarning | null; dismiss: (warning: RecordingBudgetWarning) => void } {
  const { entitlements } = useEntitlements();
  const quota = useCloudTranscriptionQuota();
  const { data: modelDefaults } = useModelDefaults();
  const { control } = usePorts().recording;
  const [nativeSession, setNativeSession] = React.useState<
    Pick<NativeRecordingState, "recordingId" | "spendsCloudQuota" | "quotaRemainingAtStartSeconds"> | null
  >(null);
  React.useEffect(() => {
    if (!control) return;
    return control.subscribe(({ recordingId, spendsCloudQuota, quotaRemainingAtStartSeconds }) => {
      setNativeSession(previous =>
        previous?.recordingId === recordingId &&
        previous.spendsCloudQuota === spendsCloudQuota &&
        previous.quotaRemainingAtStartSeconds === quotaRemainingAtStartSeconds
          ? previous
          : { recordingId, spendsCloudQuota, quotaRemainingAtStartSeconds },
      );
    });
  }, [control]);
  const [session, setSession] = React.useState<{
    id: string | null;
    quotaAtStart: number | null;
    dismissed: readonly string[];
  }>({ id: null, quotaAtStart: null, dismissed: [] });

  const quotaRemaining = !control && quota ? Math.max(0, quota.limitSeconds - quota.usedSeconds) : null;
  // A BYOK recording is transcribed on the owner's own key and never touches the org's Cloud
  // allowance (core meters and gates only the managed lane), so warning about that allowance would
  // be telling the user their transcript is about to stop when nothing of the sort is true.
  const transcription = modelDefaults?.transcription;
  // Main freezes native recording configuration at Start. Current device settings or server
  // defaults can already describe the next recording, so only its matching state is authoritative.
  // Until that state arrives, do not project Cloud usage from an unknown recording configuration.
  const spendsCloudQuota = control
    ? nativeSession?.recordingId === opts.sessionId && nativeSession?.spendsCloudQuota === true
    : !(transcription?.instanceId && transcription?.modelId);

  React.useEffect(() => {
    setSession(previous => {
      if (previous.id !== opts.sessionId) {
        return {
          id: opts.sessionId,
          quotaAtStart: opts.sessionId === null ? null : quotaRemaining,
          dismissed: [],
        };
      }
      // Same session: latch the allowance once, and otherwise return the SAME object so a usage
      // refetch does not cost a render.
      if (opts.sessionId === null || previous.quotaAtStart !== null) return previous;
      return { ...previous, quotaAtStart: quotaRemaining };
    });
  }, [opts.sessionId, quotaRemaining]);

  const warning = resolveRecordingBudgetWarning({
    // `session.id` lags `opts.sessionId` by one commit while the effect runs; until it catches up
    // the latched allowance still belongs to the previous session, so say nothing.
    isRecording: opts.sessionId !== null && session.id === opts.sessionId,
    elapsedSeconds: opts.elapsedSeconds,
    maxRecordingSeconds: entitlements.limits.maxRecordingSeconds,
    quotaRemainingAtStartSeconds: spendsCloudQuota
      ? control
        ? nativeSession?.quotaRemainingAtStartSeconds ?? null
        : session.quotaAtStart
      : null,
    dismissed: session.dismissed,
  });

  const dismiss = React.useCallback((toDismiss: RecordingBudgetWarning) => {
    const key = recordingBudgetWarningKey(toDismiss);
    setSession(previous =>
      previous.dismissed.includes(key)
        ? previous
        : { ...previous, dismissed: [...previous.dismissed, key] },
    );
  }, []);

  return { warning, dismiss };
}
