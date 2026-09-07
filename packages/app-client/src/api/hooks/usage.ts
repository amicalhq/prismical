"use client";

import { useQuery } from "@tanstack/react-query";
import {
  UsageResponseSchema,
  type CloudTranscriptionQuota,
  type Usage,
} from "@prismical/api-contracts/apps/v1";
import { useActiveOrgId } from "../../ports-context";
import { apiClient, ME_PREFIX } from "../client";

export type {
  CloudTranscriptionQuota,
  Usage,
  UsageAction,
  UsageCopy,
  UsageQuota,
} from "@prismical/api-contracts/apps/v1";

/**
 * Shared prefix so the query and every invalidation of it are built from one value — a recording
 * finishing invalidates by prefix, without having to resolve which org is active.
 */
export const usageKeyPrefix = ["usage"] as const;
export const usageKey = (activeOrgId: string | null) => [...usageKeyPrefix, activeOrgId] as const;

/**
 * The caller's own current-period usage. Unlike `usePlanAccess()` (which reads `/me/plan` and is
 * owner/admin only), this is readable by every member — the sidebar meter has to render for the
 * people most likely to run out, not just the ones who can pay.
 *
 * Deliberately its own query rather than a field on the org list: that list is cached for minutes
 * and shared with the feature flags, while these seconds move with every recording.
 */
export function useUsage() {
  const activeOrgId = useActiveOrgId();
  return useQuery<Usage>({
    queryKey: usageKey(activeOrgId),
    staleTime: 60_000,
    queryFn: async () =>
      UsageResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/usage`, undefined, { activeOrgId }),
      ),
  });
}

/** A meter there is something to draw: the unlimited case is already filtered out. */
export type CappedCloudTranscriptionQuota = CloudTranscriptionQuota & { limitSeconds: number };

/**
 * The Cloud-transcription meter, or null when there is nothing to draw: an older core that does
 * not report it, an unlimited plan, or a response still in flight. Every displayed decision —
 * label, link, upgrade call to action — arrives resolved from the server; nothing here branches
 * on a plan.
 */
export function useCloudTranscriptionQuota(): CappedCloudTranscriptionQuota | null {
  const { data } = useUsage();
  const quota = data?.quota?.cloudTranscription ?? null;
  return quota && quota.limitSeconds !== null
    ? (quota as CappedCloudTranscriptionQuota)
    : null;
}
