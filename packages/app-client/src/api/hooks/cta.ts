'use client';

import { useQuery } from '@tanstack/react-query';
import { CtaSchema, type Cta } from '@prismical/api-contracts/apps/v1';
import { apiClient, ME_PREFIX } from '../client';
import { useActiveAccountId, useActiveOrgId, useActiveSessionKey } from '../../ports-context';

import { useDesktopCapabilities } from '../../settings/use-desktop-capabilities';

export type { Cta, CtaContent } from '@prismical/api-contracts/apps/v1';

export function useCta() {
  const userId = useActiveAccountId();
  const orgId = useActiveOrgId();
  const sessionKey = useActiveSessionKey();
  const cloudWorkspace = useDesktopCapabilities().featureFlags === null;
  return useQuery<Cta | null>({
    queryKey: ['cta', sessionKey, orgId],
    enabled: cloudWorkspace && !!userId && !!orgId,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchInterval: 30_000,
    retry: 1,
    meta: { suppressErrorToast: true },
    queryFn: async ({ signal }) => {
      if (!cloudWorkspace) return null;
      const response = await apiClient.getRaw<{ cta?: unknown }>(ME_PREFIX, undefined, {
        activeOrgId: orgId,
        signal,
      });
      const parsed = CtaSchema.safeParse(response.cta);
      return parsed.success ? parsed.data : null;
    },
  });
}
