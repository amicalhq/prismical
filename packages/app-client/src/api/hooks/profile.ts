"use client";

import { useQuery } from "@tanstack/react-query";
import { ViewerProfileResponseSchema } from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";

export type { ViewerProfile } from "@prismical/api-contracts/apps/v1";

export const viewerProfileKey = ["viewer-profile"] as const;

/**
 * The current user's own profile, including their avatar `image`. Backs the "You"
 * avatar in the transcript and the account avatars in the sidebar footer. Identity rarely
 * changes, so it's cached generously; a fresh fetch on sign-in/account-switch is enough.
 */
export function useViewerProfile() {
  return useQuery({
    queryKey: viewerProfileKey,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      ViewerProfileResponseSchema.parse(await apiClient.getRaw<unknown>(`${ME_PREFIX}/profile`))
        .result,
  });
}
