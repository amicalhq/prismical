import { ModelDefaultsResponseSchema } from '@prismical/api-contracts/apps/v1';
import { Effect } from 'effect';
import type { WorkspaceBackendApi } from '../transport/service';
import { transcriptionConfigFor, type RecordingEngine } from './engine';

/** Resolve the Cloud default once before Start; the durable create intent freezes it for recovery. */
export const resolveTranscriptionConfig = (
  engine: RecordingEngine,
  backend: WorkspaceBackendApi
): Effect.Effect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const fallback = transcriptionConfigFor(engine);
    if (engine.engine !== 'cloud') return fallback;
    const response = yield* backend.request({ method: 'GET', path: '/apps/v1/me/model-defaults' });
    // Match web's ensureModelDefault: a defaults-endpoint failure does not block recording.
    if ('error' in response || response.status !== 200) return fallback;
    const parsed = ModelDefaultsResponseSchema.safeParse(response.bodyJson);
    const selection = parsed.success ? parsed.data.transcription : null;
    if (!selection?.instanceId || !selection.modelId) return fallback;
    return {
      provider: 'byok',
      model: selection.modelId,
      language: fallback.language,
      instanceId: selection.instanceId,
      modelId: selection.modelId,
    };
  });
