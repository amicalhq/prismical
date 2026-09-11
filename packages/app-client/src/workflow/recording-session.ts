import type { QueryClient } from '@tanstack/react-query';
import type { UseRecording, RecordingCompletion } from '../recording/use-recording';

export type RecordingSessionSnapshot = Omit<
  UseRecording,
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'clearError'
  | 'keepRecording'
  | 'pauseFromPrompt'
  | 'setLanguage'
> & {
  retryAvailable: boolean;
  completedRecording: (RecordingCompletion & { workflowId?: string }) | null;
};

/** Browser-owned capture survives note navigation within this tab. */
export interface RecordingSessionClient {
  getSnapshot(): RecordingSessionSnapshot;
  subscribe(listener: () => void): () => void;
  start: UseRecording['start'];
  pause: UseRecording['pause'];
  resume: UseRecording['resume'];
  stop: UseRecording['stop'];
  clearError: UseRecording['clearError'];
  retry(): Promise<void>;
  abandon(): Promise<void>;
  keepRecording: UseRecording['keepRecording'];
  pauseFromPrompt: UseRecording['pauseFromPrompt'];
  /** Optional until every shell implements it; a missing one means a change cannot follow a running recording. */
  setLanguage?: UseRecording['setLanguage'];
  configure(options: { skipAutoEnhanceForNote?: string; queryClient?: QueryClient }): void;
  dispose(): void;
}
