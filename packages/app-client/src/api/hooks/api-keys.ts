"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiKeyListResponseSchema,
  CreatedApiKeySchema,
  type CreateApiKeyRequest,
} from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";

export type { ApiKey, CreatedApiKey } from "@prismical/api-contracts/apps/v1";
import type { ApiKey } from "@prismical/api-contracts/apps/v1";

export const apiKeysKey = ["api-keys"] as const;

/**
 * Public API keys. User-JWT only; the secret is returned
 * exactly once on create and never again — the list endpoint projects columns
 * so the hash never leaves the server.
 */

/** GET /me/api-keys row — dates arrive as ISO strings over JSON. */
export type CreateApiKeyInput = CreateApiKeyRequest;

export function useApiKeys() {
  return useQuery<ApiKey[]>({
    queryKey: apiKeysKey,
    queryFn: async () =>
      ApiKeyListResponseSchema.parse(await apiClient.getRaw<unknown>(`${ME_PREFIX}/api-keys`))
        .results,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    // The page renders the create error inline in the dialog.
    meta: { suppressErrorToast: true },
    mutationFn: async (input: CreateApiKeyInput) =>
      CreatedApiKeySchema.parse(await apiClient.postRaw<unknown>(`${ME_PREFIX}/api-keys`, input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: apiKeysKey }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.apiKeyRevoke" },
    mutationFn: (id: string) => apiClient.del(`${ME_PREFIX}/api-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: apiKeysKey }),
  });
}
