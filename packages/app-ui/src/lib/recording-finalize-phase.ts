import type { CoreRecording } from '@prismical/app-client';

export function recordingIsProcessing(phase: string | null): boolean {
  return phase === 'pending' || phase === 'running';
}

/** Read the processing phase independently of the recording's capture duration. */
export function recordingFinalizePhase(recording: CoreRecording, now = Date.now()): string | null {
  const meta = (recording.meta ?? {}) as {
    import?: { phase?: string };
    staging?: { status?: string; stagedAt?: string };
    finalize?: { status?: string };
  };
  if (meta.import) {
    const p = meta.import.phase;
    const phase =
      p === 'checking'
        ? 'pending'
        : p === 'transcribing'
          ? 'running'
          : p === 'ready'
            ? 'done'
            : (p ?? null);
    const anchor = Date.parse(recording.updatedAt ?? '');
    return recordingIsProcessing(phase) && Number.isFinite(anchor) && now - anchor >= 30 * 60_000
      ? 'stalled'
      : phase;
  }
  const phase = meta.finalize?.status ?? (meta.staging?.status === 'staged' ? 'pending' : null);
  if (!recordingIsProcessing(phase)) return phase;
  const anchor = Date.parse(meta.staging?.stagedAt ?? recording.endedAt ?? '');
  return Number.isFinite(anchor) && now - anchor >= 30 * 60_000 ? 'stalled' : phase;
}
