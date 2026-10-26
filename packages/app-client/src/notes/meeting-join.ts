/** How early before its start a meeting's Join also starts recording its note. */
export const JOIN_RECORDING_LEAD_MS = 15 * 60_000;

/**
 * Whether pressing Join on a meeting row should also open its note and start recording: only for a
 * meeting that is under way or about to start. Join on a meeting days out is someone checking the
 * link, not joining the call, and must not start a recording. An all-day event never records: it
 * spans the whole day (from the evening before, west of UTC), so it says nothing about a call.
 */
export function recordsOnJoin(
  start: Date | string,
  end: Date | string,
  isAllDay: boolean | undefined,
  nowMs: number = Date.now()
): boolean {
  if (isAllDay) return false;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
  return nowMs >= startMs - JOIN_RECORDING_LEAD_MS && nowMs < endMs;
}
