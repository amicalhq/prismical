"use client";

import type { SyncWriteEnvelope } from "@prismical/api-contracts/apps/v1";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InstanceModelsResponseSchema } from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";
import { toInstance, type CoreInstance } from "../adapters";
import type { CatalogEntry, Instance, InstanceConfig } from "@prismical/app-contracts";

export const instancesKey = ["instances"] as const;
export const instanceModelsKey = (id: string) => ["instance-models", id] as const;

export function useInstances() {
  return useQuery<Instance[]>({
    queryKey: instancesKey,
    queryFn: async () =>
      (await apiClient.list<CoreInstance>(`${ME_PREFIX}/instances`)).map(toInstance),
  });
}

/**
 * The live model catalog for one instance (GET /me/instances/:id/models — fetched server-side from
 * the provider with the instance's key). Powers the curation picker in the connect/edit dialog. Only
 * runs when `enabled` (dialog open + an editable instance whose provider supports a catalog), since it
 * needs the stored credential. The list changes rarely, so it's cached and not refetched on focus.
 */
export function useInstanceModels(id: string | undefined, enabled: boolean) {
  return useQuery<CatalogEntry[]>({
    queryKey: instanceModelsKey(id ?? ""),
    queryFn: async () =>
      InstanceModelsResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/instances/${id}/models`),
      ).results,
    enabled: Boolean(id) && enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export interface InstanceWrite {
  provider: string;
  label: string;
  config: InstanceConfig;
  credentials?: Record<string, unknown>;
}

export function useCreateInstance() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.providerAdd" },
    mutationFn: (v: InstanceWrite) =>
      apiClient
        .post<SyncWriteEnvelope<CoreInstance>>(`${ME_PREFIX}/instances`, v)
        .then((response) => response.result),
    onSuccess: () => qc.invalidateQueries({ queryKey: instancesKey }),
  });
}

export function useUpdateInstance() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.providerSave" },
    mutationFn: ({ id, patch }: { id: string; patch: Partial<InstanceWrite> }) =>
      apiClient
        .put<SyncWriteEnvelope<CoreInstance>>(`${ME_PREFIX}/instances/${id}`, patch)
        .then((response) => response.result),
    onSuccess: () => qc.invalidateQueries({ queryKey: instancesKey }),
  });
}

export function useDeleteInstance() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.providerRemove" },
    mutationFn: (id: string) => apiClient.del(`${ME_PREFIX}/instances/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: instancesKey }),
  });
}
