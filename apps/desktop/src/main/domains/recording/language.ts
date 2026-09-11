import { Effect } from 'effect';
import { SyncWriteResponseSchema } from '@prismical/api-contracts/apps/v1';
import type { WorkspaceBackendApi } from '../transport/service';

/** Replay the complete pinned config: replacing this JSON column must retain provider/model IDs. */
export const saveRecordingTranscriptionConfig = (
  backend: WorkspaceBackendApi,
  recordingId: string,
  transcriptionConfig: Record<string, unknown>
): Effect.Effect<'saved' | 'rejected' | 'uncertain'> => backend.request({
  method: 'PUT',
  path: `/apps/v1/me/recordings/${recordingId}`,
  body: { transcriptionConfig },
}).pipe(Effect.map(response => {
  if (!('ok' in response)) return 'uncertain';
  if (response.status >= 400 && response.status < 500) return 'rejected';
  if (response.status < 200 || response.status >= 300) return 'uncertain';
  const parsed = SyncWriteResponseSchema.safeParse(response.bodyJson);
  return parsed.success ? parsed.data.applied ? 'saved' : 'rejected' : 'uncertain';
}));
