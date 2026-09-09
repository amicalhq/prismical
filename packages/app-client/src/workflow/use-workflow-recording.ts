'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePorts } from '../ports-context';
import type { RecordingSessionClient } from './recording-session';
import { EVENTS } from '../analytics-events';
import { transcriptKey, recordingsKey, noteRecordingsKey, enhancedRecordingsKey } from '../api/hooks/transcripts';
import { usageKeyPrefix } from '../api/hooks/usage';
import { useAutoEnhanceStore } from '../notes/auto-enhance-store';

const handledCompletions = new WeakMap<RecordingSessionClient, string>();

export function useWorkflowRecording(client: RecordingSessionClient, skipAutoEnhanceForNote?: string) {
  const snapshot = React.useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const qc = useQueryClient();
  const { analytics } = usePorts();
  React.useEffect(() => {
    client.configure({ skipAutoEnhanceForNote, queryClient: qc });
  }, [client, skipAutoEnhanceForNote, qc]);
  React.useEffect(() => {
    const finished = snapshot.completedRecording;
    if (!finished || handledCompletions.get(client) === finished.recordingId) return;
    handledCompletions.set(client, finished.recordingId);
    for (const queryKey of [transcriptKey(finished.recordingId), recordingsKey(finished.noteId),
      noteRecordingsKey(finished.noteId), enhancedRecordingsKey(finished.noteId), usageKeyPrefix]) {
      void qc.invalidateQueries({ queryKey });
    }
    analytics.capture(EVENTS.RECORDING_COMPLETED, {
      note_id: finished.noteId, recording_id: finished.recordingId, segments: finished.segments,
    });
    if (finished.workflowId) useAutoEnhanceStore.getState().requestAutoEnhance({
      ...finished, source: 'auto-enhance',
    }, analytics);
  }, [snapshot.completedRecording, qc, analytics, client]);
  return { ...snapshot, start: client.start, pause: client.pause, resume: client.resume,
    stop: client.stop, retry: client.retry, abandon: client.abandon, clearError: client.clearError, keepRecording: client.keepRecording,
    pauseFromPrompt: client.pauseFromPrompt };
}
