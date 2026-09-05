/**
 * The provider-selection routes the shared renderer polls, served from
 * AiProvider instead of the server: /me/instances (the configured
 * providers as synthetic rows the Ask model picker groups), an instance's
 * catalogue, and /me/model-defaults (the device default the skill runner and
 * the AI-models screen read; PUT repoints it).
 */
import { SetModelDefaultRequestSchema } from '@prismical/api-contracts/apps/v1';
import { providerOfInstanceId } from '../ai-provider/instances';
import type { LocalAiPort } from './ai-port';
import { apiError, invalidRequest, notFound, ok, type RouteResult } from './wire';

/** A fixed stamp: the rows are derived, not stored, and the delta list keys on updatedAt. */
const SYNTHETIC_STAMP = '2026-01-01T00:00:00.000Z';

export async function listInstances(ai: LocalAiPort): Promise<RouteResult> {
  const rows = await ai.instances();
  return ok({
    results: rows.map(row => ({
      id: row.instanceId,
      provider: row.provider,
      label: row.label,
      config: { selectedModels: row.models },
      createdAt: SYNTHETIC_STAMP,
      updatedAt: SYNTHETIC_STAMP,
      deletedAt: null,
    })),
  });
}

export async function instanceModels(ai: LocalAiPort, instanceId: string): Promise<RouteResult> {
  const provider = providerOfInstanceId(instanceId);
  if (provider === null) return notFound();
  const listing = await ai.listModels(provider);
  return ok({
    results: listing.models.map(id => ({ id, name: id, type: 'language' })),
  });
}

export async function getModelDefaults(ai: LocalAiPort): Promise<RouteResult> {
  const formatting = await ai.defaultSelection();
  return ok({ formatting, transcription: null });
}

export async function setModelDefault(ai: LocalAiPort, body: unknown): Promise<RouteResult> {
  const parsed = SetModelDefaultRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest('Invalid request');
  const { useCase, instanceId, modelId } = parsed.data;
  // Transcription defaults belong to the engine setting; accept as a no-op.
  if (useCase === 'transcription' || instanceId === undefined) {
    return ok({ useCase, instanceId: null, modelId: null });
  }
  if (modelId === undefined) return apiError(422, 'MODEL_REQUIRED', 'Invalid model selection');
  const applied = await ai.setDefault({ instanceId, modelId });
  if (!applied) return apiError(404, 'INSTANCE_NOT_FOUND', 'Provider instance not found');
  return ok({ useCase, instanceId, modelId });
}
