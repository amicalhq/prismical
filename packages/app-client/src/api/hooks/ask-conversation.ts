'use client';

import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import {
  AskConversationResponseSchema,
  AskConversationHistoryResponseSchema,
  StoredConversationSchema,
  type StoredConversation,
} from '@prismical/api-contracts/apps/v1';
import { apiClient, ME_PREFIX } from '../client';
import { useActiveOrgId, useActiveSessionKey } from '../../ports-context';

export const askConversationKey = ['ask-conversation', 'latest'] as const;

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
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/ask/conversations`)
      ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Load summaries only while the history picker is mounted. */
export function useConversationHistory(search: string) {
  const sessionKey = useActiveSessionKey();
  const orgId = useActiveOrgId();
  return useInfiniteQuery({
    queryKey: ['ask-conversation-history', sessionKey, orgId, search],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const query = new URLSearchParams({ search, offset: String(pageParam) });
      return AskConversationHistoryResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/ask/conversations/history?${query}`)
      );
    },
    getNextPageParam: page => page.nextOffset ?? undefined,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export async function loadAskConversation(id: string) {
  return StoredConversationSchema.parse(
    await apiClient.getRaw<unknown>(`${ME_PREFIX}/ask/conversations/${encodeURIComponent(id)}`)
  );
}
