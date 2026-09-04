"use client";

import { useQuery } from "@tanstack/react-query";
import { SearchResponseSchema, type SearchHit } from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";

export type { SearchHit } from "@prismical/api-contracts/apps/v1";

/** Full-text note search via /me/search. Disabled until the query is non-empty. */
export function useSearch(query: string) {
  return useQuery<SearchHit[]>({
    queryKey: ["search", query],
    queryFn: async () =>
      SearchResponseSchema.parse(await apiClient.getRaw<unknown>(`${ME_PREFIX}/search`, { query }))
        .results,
    enabled: query.trim().length > 0,
  });
}
