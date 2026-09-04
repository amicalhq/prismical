"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AutomationListResponseSchema,
  AutomationResponseSchema,
  AutomationRunResponseSchema,
  AutomationRunsResponseSchema,
  AutomationSecretResponseSchema,
  CreatedAutomationResponseSchema,
  type Automation,
  type AutomationRunsResponse,
  type CreateAutomationRequest,
} from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";

export type {
  Automation,
  AutomationEventType,
  AutomationRun,
  AutomationTriggerConfig,
  CreatedAutomation,
} from "@prismical/api-contracts/apps/v1";

/**
 * Automations: trigger → action wiring managed at /me/automations.
 * Fetch-per-view like api-keys — not a sync-plane entity.
 */

export const automationsKey = ["automations"] as const;
export const automationKey = (id: string) => ["automations", id] as const;
export const automationRunsKey = (id: string) => ["automations", id, "runs"] as const;

export type AutomationInput = CreateAutomationRequest;

export function useAutomations() {
  return useQuery<Automation[]>({
    queryKey: automationsKey,
    queryFn: async () =>
      AutomationListResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/automations`),
      ).results,
  });
}

export function useAutomation(id: string | null) {
  return useQuery<Automation>({
    queryKey: automationKey(id ?? "none"),
    enabled: Boolean(id),
    queryFn: async () =>
      AutomationResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/automations/${id}`),
      ).result,
  });
}

export function useCreateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    // The builder dialog renders create errors inline.
    meta: { suppressErrorToast: true },
    mutationFn: async (input: AutomationInput) =>
      CreatedAutomationResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/automations`, input),
      ).result,
    onSuccess: () => qc.invalidateQueries({ queryKey: automationsKey, exact: true }),
  });
}

/**
 * `silent` suppresses the global error toast — the builder dialog renders update errors
 * inline; the list/detail enable-toggles keep the toast.
 */
export function useUpdateAutomation(opts?: { silent?: boolean }) {
  const qc = useQueryClient();
  return useMutation({
    meta: opts?.silent
      ? { suppressErrorToast: true }
      : { errorMessageKey: "common.mutationErrors.automationUpdate" },
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<AutomationInput> }) =>
      AutomationResponseSchema.parse(
        await apiClient.patchRaw<unknown>(`${ME_PREFIX}/automations/${id}`, patch),
      ).result,
    onSuccess: (updated) => {
      qc.setQueryData<Automation[]>(automationsKey, (prev) =>
        prev?.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)),
      );
      // exact — the bare key is also the prefix of detail/runs/secret keys, and a config
      // update must not force a signing-secret refetch.
      void qc.invalidateQueries({ queryKey: automationsKey, exact: true });
      void qc.invalidateQueries({ queryKey: automationKey(updated.id), exact: true });
    },
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.automationDelete" },
    mutationFn: (id: string) => apiClient.del(`${ME_PREFIX}/automations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationsKey }),
  });
}

type RunsPage = AutomationRunsResponse;

/**
 * Recent run history. Polls while mounted: runs settle asynchronously (drain + retries), and a
 * 15s refetch keeps the "Delivering…" → "Delivered" transition visible without a manual reload.
 */
export function useAutomationRuns(id: string | null, limit = 50) {
  return useQuery<RunsPage>({
    queryKey: [...automationRunsKey(id ?? "none"), limit],
    enabled: Boolean(id),
    refetchInterval: 15_000,
    queryFn: () =>
      apiClient
        .getRaw<unknown>(`${ME_PREFIX}/automations/${id}/runs`, { limit })
        .then((response) => AutomationRunsResponseSchema.parse(response)),
  });
}

export function useRetryAutomationRun(automationId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.automationReplay" },
    mutationFn: async (runId: string) =>
      AutomationRunResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/automation-runs/${runId}/retry`, {}),
      ).result,
    onSuccess: () => qc.invalidateQueries({ queryKey: automationRunsKey(automationId) }),
  });
}

/** Signing secret reveal — fetched on demand (never cached beyond the page). */
export function useAutomationSecret(id: string | null, enabled: boolean) {
  return useQuery<{ secret: string }>({
    queryKey: ["automations", id ?? "none", "secret"],
    enabled: Boolean(id) && enabled,
    gcTime: 0,
    staleTime: Infinity,
    queryFn: async () =>
      AutomationSecretResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/automations/${id}/secret`),
      ).result,
  });
}

export function useRotateAutomationSecret(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.automationRotateSecret" },
    mutationFn: async () =>
      AutomationSecretResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/automations/${id}/rotate-secret`, {}),
      ).result,
    onSuccess: (r) => qc.setQueryData(["automations", id, "secret"], r),
  });
}
