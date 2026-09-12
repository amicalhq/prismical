'use client';

/**
 * SyncStoreProvider — owns the active partition's sync
 * store for the signed-in (account, org) identity and swaps it whole on any
 * identity change (the store-side twin of OrgScopedCacheReset: cross-identity
 * reads are impossible because the store instance itself is per-partition).
 *
 * Mounted inside ApiQueryProvider (query-client.tsx), so BOTH shells — web and
 * desktop — get it without shell edits. Each shell injects a persistence factory
 * via configureAppClient({ syncPersistence }) → each partition hydrates from
 * its own IndexedDB database for the instant warm boot.
 *
 * On mount the synchronized collections are activated immediately (warm partitions
 * paint from disk before any network settles) and the delta poller starts
 * (interval + focus + online, with no scheduled full refresh).
 * Terminally-rejected writes surface through the same sonner toast lane the
 * old react-query mutation `meta.errorMessage` used — a rejected save/delete
 * never fails silently.
 */
import * as React from 'react';
import { observe } from '@legendapp/state';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ApplicationTranslationKey } from '@prismical/app-i18n';
import {
  useActiveAccountId,
  useActiveOrgId,
  useActiveSessionKey,
  useEnv,
  usePorts,
} from '../ports-context';
import { startLoadingTiming } from '../loading-timing';
import { ApiError } from '../api/client';
import { getSyncPersistenceFactory } from '../runtime';
import { partitionDatabaseName } from './partition';
import { purgeAccountPartitions, registerPartitionDatabase } from './purge';
import { createSyncStore, type SyncStore } from './store';
import { PartitionPersistence } from './persist';

const REJECTION_MESSAGE_KEYS: Record<string, Record<string, ApplicationTranslationKey>> = {
  notes: {
    create: 'common.mutationErrors.noteCreate',
    update: 'common.mutationErrors.noteSave',
    delete: 'common.mutationErrors.noteDelete',
  },
  folders: {
    create: 'common.mutationErrors.folderCreate',
    update: 'common.mutationErrors.folderUpdate',
    delete: 'common.mutationErrors.folderDelete',
  },
  noteEvents: {
    create: 'common.mutationErrors.noteEventLink',
    update: 'common.mutationErrors.noteEventLink',
    delete: 'common.mutationErrors.noteEventUnlink',
  },
  tags: {
    create: 'common.mutationErrors.tagCreate',
    update: 'common.mutationErrors.tagUpdate',
    delete: 'common.mutationErrors.tagDelete',
  },
  'note-tags': {
    create: 'common.mutationErrors.tagAdd',
    delete: 'common.mutationErrors.tagRemove',
  },
};

const SyncStoreContext = React.createContext<SyncStore | null>(null);

export function SyncStoreProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const translationRef = React.useRef(t);
  translationRef.current = t;
  const accountId = useActiveAccountId();
  const sessionKey = useActiveSessionKey();
  const orgId = useActiveOrgId();
  const { platform } = useEnv();
  const { auth, analytics } = usePorts();
  const analyticsRef = React.useRef(analytics);
  analyticsRef.current = analytics;
  const [published, setPublished] = React.useState<{
    store: SyncStore;
    accountId: string;
    sessionKey: string | null;
    orgId: string | null;
    platform: string;
    auth: typeof auth;
  } | null>(null);
  const previousAccountRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const previous = previousAccountRef.current;
    previousAccountRef.current = accountId;
    if (!accountId) {
      // Full sign-out: purge the departing account's partitions — local product
      // data must not survive a signed-out account. (An account removed
      // while another stays active is not detectable from the active id alone —
      // its partitions purge on its next full sign-out; acceptable residual.)
      if (previous) void purgeAccountPartitions(previous);
      setPublished(null);
      return;
    }
    // Web must select its concrete workspace before accepting writes. A store
    // using the server's implicit default is replaced by that selection, losing
    // optimistic creates even when their POST subsequently succeeds.
    if (platform === 'web' && !orgId) {
      setPublished(null);
      return;
    }
    const timing = startLoadingTiming(analyticsRef.current, 'sync_bootstrap');
    let cancelled = false;
    let created: SyncStore | null = null;
    let stopPersistenceErrors = () => {};
    const partition = { accountSub: accountId, orgId: orgId ?? '' };
    void (async () => {
      const factory = getSyncPersistenceFactory();
      let plugin = null;
      let persistenceError: Error | undefined;
      if (factory) {
        try {
          plugin = await factory(partition);
          registerPartitionDatabase(accountId, partitionDatabaseName(partition));
        } catch (error) {
          // Online access can continue, but this session cannot promise durable
          // metadata. Report storage failure instead of silently degrading.
          console.error('[sync] partition persistence unavailable — running in-memory', error);
          persistenceError = error instanceof Error ? error : new Error(String(error));
          plugin = null;
        }
      }
      if (cancelled) {
        if (plugin instanceof PartitionPersistence) plugin.close();
        return;
      }
      timing.mark('persistence_ready');
      created = createSyncStore({
        partition,
        persistPlugin: plugin,
        persistenceError,
        ...(platform === 'web'
          ? {
              getRequestOptions: async () => {
                if (cancelled || !sessionKey) {
                  throw new ApiError('AUTH_CONTEXT_CHANGED', 'Session changed', 401);
                }
                const authToken = await auth.getTokenForSession(sessionKey, orgId);
                if (cancelled || !authToken) {
                  throw new ApiError('AUTH_CONTEXT_CHANGED', 'Session changed', 401);
                }
                return { authToken, activeOrgId: orgId };
              },
            }
          : {}),
        onWriteRejected: ({ collection, op }) => {
          toast.error(
            translationRef.current(
              REJECTION_MESSAGE_KEYS[collection]?.[op] ?? 'common.errors.generic'
            )
          );
        },
      });
      const errors$ = created.persistenceError$;
      stopPersistenceErrors = observe(() => {
        if (errors$.get()) toast.error(translationRef.current('common.errors.generic'));
      });
      // Writes begin only after local tables hydrate. The store reconciles remote
      // snapshots with pending rows, so a hanging GET cannot block local creation.
      await created.whenLocalReady();
      if (cancelled) return;
      timing.mark('local_loaded');
      created.startPolling();
      setPublished({ store: created, accountId, sessionKey, orgId, platform, auth });
      timing.finish('published');
    })().catch(error => {
      if (cancelled) return;
      console.error('[sync] local initialization failed', error);
      toast.error(translationRef.current('common.errors.generic'));
      timing.finish('error');
    });
    return () => {
      cancelled = true;
      timing.finish('abandoned');
      stopPersistenceErrors();
      created?.dispose();
      setPublished(null);
    };
  }, [accountId, sessionKey, orgId, platform, auth]);

  // Effects clean up after the new identity has already rendered. Do not expose
  // the previous store during that commit: a queued child action may run first.
  const store =
    published?.accountId === accountId &&
    published.sessionKey === sessionKey &&
    published.orgId === orgId &&
    published.platform === platform &&
    published.auth === auth
      ? published.store
      : null;
  return <SyncStoreContext.Provider value={store}>{children}</SyncStoreContext.Provider>;
}

/**
 * The active partition's sync store, or null while signed out / the partition
 * is still constructing. Synchronized hooks fold the null into their isLoading
 * state — screens render the same skeletons they always did.
 */
export function useSyncStore(): SyncStore | null {
  return React.useContext(SyncStoreContext);
}
