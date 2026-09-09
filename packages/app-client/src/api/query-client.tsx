'use client';

import { reportClientError } from "../diagnostics";

import * as React from 'react';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { ApplicationTranslationKey } from '@prismical/app-i18n';
import { useActiveAccountId, useActiveOrgId, useActiveSessionKey } from '../ports-context';
import { SyncStoreProvider } from '../sync/provider';
import { mutationErrorMessage } from './mutation-error';

// Per-mutation control over the global error toast below. Set these on a
// mutation's `meta` to customise the message or opt out entirely (e.g. when the
// call site already renders an inline error).
declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** Catalog key shown as the error toast when the mutation rejects. */
      errorMessageKey?: ApplicationTranslationKey;
      /** Skip the global error toast (the UI surfaces the failure itself). */
      suppressErrorToast?: boolean;
    };
  }
}

// One QueryClient per browser tab; defaults mirror the desktop renderer
// (no refetch-on-focus, no auto retry — fail fast, surface errors to the UI).
//
// A single MutationCache.onError makes a failed save/delete never fail silently:
// any mutation that rejects without bespoke handling raises a toast. Mutations
// that render their own error UI opt out via `meta.suppressErrorToast`.
export function ApiQueryProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const translationRef = React.useRef(t);
  translationRef.current = t;
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
        },
        queryCache: new QueryCache({
          onError: (error) => reportClientError(error, { operation: "query" }),
        }),
        mutationCache: new MutationCache({
          onError: (_error, _vars, _ctx, mutation) => {
            reportClientError(_error, { operation: "mutation" });
            if (mutation.meta?.suppressErrorToast) return;
            toast.error(
              mutationErrorMessage(translationRef.current, mutation.meta?.errorMessageKey)
            );
          },
        }),
      })
  );
  return (
    <QueryClientProvider client={client}>
      <OrgScopedCacheReset />
      <SyncStoreProvider>{children}</SyncStoreProvider>
    </QueryClientProvider>
  );
}

// All `/me/*` data is org-scoped (and account-scoped) server-side, and the active
// account+org ride on a single request header seam (no account/org in the query
// keys). So when the user switches organization OR account we drop every scoped cache
// entry, forcing a clean refetch under the new context — a cross-org/cross-account
// leak is then impossible by construction. The org LIST is preserved so the
// switcher doesn't flicker. Only a real context change resets; the initial
// null→value hydration doesn't (those queries already fetched under the resolved
// context), avoiding a redundant reload on first paint.
function OrgScopedCacheReset() {
  const orgId = useActiveOrgId();
  const accountId = useActiveAccountId();
  const sessionKey = useActiveSessionKey();
  const qc = useQueryClient();
  // A switch in EITHER dimension is a context change. (org list excluded below;
  // it's account-scoped via the header but harmless to keep across an org switch,
  // and it's refetched anyway on an account switch.)
  const key = `${sessionKey ?? ''}::${accountId ?? ''}::${orgId ?? ''}`;
  const prev = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    const from = prev.current;
    prev.current = key;
    if (from === undefined || from === key) return;
    if (accountId == null) return; // signed out → AuthGuard handles; nothing to refetch
    const [previousSessionKey, previousAccountId] = from.split('::');
    const sessionChanged = previousSessionKey !== sessionKey;
    const accountChanged = previousAccountId !== accountId;
    if (sessionChanged || accountChanged) {
      // Different user → drop EVERYTHING (incl. the org list) and refetch.
      void qc.resetQueries();
      return;
    }
    // Same account, org changed. Skip the null→org hydration (org not resolved yet)
    // so first paint doesn't redundantly reload; keep the org list across the switch.
    if (orgId == null) return;
    void qc.resetQueries({ predicate: q => q.queryKey[0] !== 'organizations' });
  }, [key, accountId, sessionKey, orgId, qc]);

  return null;
}
