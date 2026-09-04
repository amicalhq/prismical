"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AskConversationResponseSchema,
  type StoredConversation,
} from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";

export const askConversationKey = ["ask-conversation", "latest"] as const;

/**
 * The caller's latest persisted Ask AI conversation, used to resume the thread on mount.
 * Returns `null` when the user has never asked anything. `staleTime: Infinity` so this loads once and
 * never refetches mid-session — the live `useChat` owns the in-memory thread after that; a full reload
 * remounts and refetches the freshly-persisted history.
 */
export function useLatestConversation() {
  return useQuery<StoredConversation | null>({
    queryKey: askConversationKey,
    queryFn: async () =>
      AskConversationResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/ask/conversations`),
      ).result,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
