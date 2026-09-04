"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  ModelDefaultsResponseSchema,
  SetModelDefaultResponseSchema,
  type ModelDefaultSelection,
  type ModelDefaults,
  type SetModelDefaultRequest,
} from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";
import type { UseCase } from "@prismical/app-contracts";

// Wire contracts for the server's per-user `/me/model-defaults` endpoints.
// A default is ONE (instanceId, modelId) per use case — distinct from Ask's curated list. The server
// stores `instanceId: null` for managed Auto; a missing use case ⇒ no row ⇒ also Auto (until org
// defaults land). The store maps both to the Auto sentinel.

/** Raw selection as the server returns it: instanceId/modelId null ⇒ managed Auto. */
export type CoreModelDefault = ModelDefaultSelection;
export type CoreModelDefaults = ModelDefaults;

/** Request params for a use case's default: a BYOK pick ⇒ {instanceId, modelId}; Auto/none ⇒ {}
 * (omitted so the backend uses managed Auto). Used by the skill-run + recording-create clients. */
export function byokSendParams(d: CoreModelDefault | null | undefined): {
  instanceId?: string;
  modelId?: string;
} {
  return d && d.instanceId && d.modelId ? { instanceId: d.instanceId, modelId: d.modelId } : {};
}

export const modelDefaultsKey = ["model-defaults"] as const;

/** Shared so callbacks (skill run, recording start) can `ensureQueryData` before sending — the
 * default must be loaded, or a run/recording silently falls back to managed Auto (sticky for
 * recordings, whose model is frozen at create). */
export const modelDefaultsQueryOptions = {
  queryKey: modelDefaultsKey,
  queryFn: async () =>
    ModelDefaultsResponseSchema.parse(
      await apiClient.getRaw<unknown>(`${ME_PREFIX}/model-defaults`),
    ).result,
  staleTime: 60_000,
};

export function useModelDefaults() {
  return useQuery<CoreModelDefaults>(modelDefaultsQueryOptions);
}

/**
 * Resolve the defaults for a one-shot action: prefer the cache; otherwise fetch and await. On a
 * fetch error, fall back to undefined (managed Auto) so a defaults-endpoint hiccup never blocks the
 * action. Returns the BYOK send-params for the use case ({} ⇒ Auto).
 */
export async function ensureModelDefault(
  qc: QueryClient,
  useCase: UseCase,
  opts?: { activeOrgId?: string; authToken?: string },
): Promise<{ instanceId?: string; modelId?: string }> {
  let defaults = qc.getQueryData<CoreModelDefaults>(modelDefaultsKey);
  if (!defaults) {
    try {
      defaults = opts?.authToken
        ? ModelDefaultsResponseSchema.parse(
            await apiClient.getRaw<unknown>(`${ME_PREFIX}/model-defaults`, undefined, opts),
          ).result
        : await qc.ensureQueryData(modelDefaultsQueryOptions);
      if (opts?.authToken) qc.setQueryData(modelDefaultsKey, defaults);
    } catch {
      defaults = undefined; // endpoint hiccup → managed Auto rather than blocking the action
    }
  }
  return byokSendParams(useCase === "formatting" ? defaults?.formatting : defaults?.transcription);
}

export type SetModelDefaultBody = SetModelDefaultRequest;

export function useSetModelDefault() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.defaultModelSave" },
    mutationFn: async (body: SetModelDefaultBody) =>
      SetModelDefaultResponseSchema.parse(
        await apiClient.putRaw<unknown>(`${ME_PREFIX}/model-defaults`, body),
      ).result,
    onSuccess: () => qc.invalidateQueries({ queryKey: modelDefaultsKey }),
  });
}

/** Clear a use case's default → revert to inherit / managed Auto (DELETE /me/model-defaults). */
export function useClearModelDefault() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.defaultModelReset" },
    mutationFn: (useCase: UseCase) =>
      apiClient.del(`${ME_PREFIX}/model-defaults?useCase=${useCase}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: modelDefaultsKey }),
  });
}
