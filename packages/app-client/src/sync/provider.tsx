'use client';

/**
 * SyncStoreProvider — owns the active partition's sync
 * store for the signed-in (account, org) identity and swaps it whole on any
 * identity change (the store-side twin of OrgScopedCacheReset: cross-identity
 * reads are impossible because the store instance itself is per-partition).
 *
 * Mounted inside ApiQueryProvider (query-client.tsx), so BOTH shells — web and
 * desktop — get it without shell edits. Desktop injects a persistence factory
 * via configureAppClient({ syncPersistence }) → each partition hydrates from
 * its own IndexedDB database for the instant warm boot; web has no factory and
 * runs the store in-memory (every boot a full pull ≈ today's behavior).
 *
 * On mount the synchronized collections are activated immediately (warm partitions
 * paint from disk before any network settles) and the delta poller starts
 * (interval + focus + online, with no scheduled full refresh).
 * Terminally-rejected writes surface through the same sonner toast lane the
 * old react-query mutation `meta.errorMessage` used — a rejected save/delete
 * never fails silently.
 */
import { observe, syncState } from '@legendapp/state';
import * as React from 'react';
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
import { ApiError } from '../api/client';
import { getSyncPersistenceFactory } from '../runtime';
import { partitionDatabaseName } from './partition';
import { purgeAccountPartitions, registerPartitionDatabase } from './purge';
import { createSyncStore, type SyncStore } from './store';

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

/**
 * Resolves once every synchronized collection has finished its first pull (or failed it — a store that
 * can never load must still be published, or the app would sit in a permanent loading state with
 * no way to write). Each collection is already activated by the caller, so this only waits.
 */
function whenWaveOneLoaded(store: SyncStore): Promise<void> {
  const collections = [store.notes$, store.folders$, store.tags$, store.noteTags$];
  return Promise.all(
    collections.map(
      collection$ =>
        new Promise<void>(resolve => {
          const state = syncState(collection$ as never);
          const settled = () => state.isLoaded.get() || !!state.error.get();
          if (settled()) {
            resolve();
            return;
          }
          const dispose = observe(() => {
            if (!settled()) return;
            resolve();
            // `observe` hands its own disposer to the reaction; calling the outer binding is safe
            // because the first run cannot settle (guarded above).
            dispose?.();
          });
        })
    )
  ).then(() => undefined);
}

export function SyncStoreProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const translationRef = React.useRef(t);
  translationRef.current = t;
  const accountId = useActiveAccountId();
  const sessionKey = useActiveSessionKey();
  const orgId = useActiveOrgId();
  const { platform } = useEnv();
  const { auth } = usePorts();
  const [store, setStore] = React.useState<SyncStore | null>(null);
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
      setStore(null);
      return;
    }
    let cancelled = false;
    let created: SyncStore | null = null;
    const partition = { accountSub: accountId, orgId: orgId ?? '' };
    void (async () => {
      const factory = getSyncPersistenceFactory();
      let plugin = null;
      if (factory) {
        try {
          plugin = await factory(partition);
          registerPartitionDatabase(accountId, partitionDatabaseName(partition));
        } catch (error) {
          // Persistence must never block the session: degrade to an in-memory
          // store (a full pull, like web) and log.
          console.error('[sync] partition persistence unavailable — running in-memory', error);
          plugin = null;
        }
      }
      if (cancelled) return;
      created = createSyncStore({
        partition,
        persistPlugin: plugin,
        ...(platform === 'web'
          ? {
              getRequestOptions: async () => {
                if (!sessionKey) {
                  throw new ApiError('AUTH_CONTEXT_CHANGED', 'Session changed', 401);
                }
                const authToken = await auth.getTokenForSession(sessionKey, orgId);
                if (!authToken) {
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
      // Activate the collections now: warm partitions hydrate from disk (instant paint);
      // cold ones start their first pull.
      created.notes$.get();
      created.folders$.get();
      created.tags$.get();
      created.noteTags$.get();
      created.noteEvents$.get();
      created.startPolling();
      // Do NOT publish the store until that first pull has settled. A write applied while it is
      // still in flight is destroyed by it: the initial list carries no `lastSync`, so it returns
      // every row and replaces the collection wholesale, taking any locally-minted row the server
      // has never heard of with it — and because the row is gone before the push queue flushes, no
      // create is ever sent. There is no rejection and no error; the note simply ceases to exist
      // while the URL still points at it, and the screen reads "Note not found" forever.
      //
      // store.test.ts's `activate()` helper describes this as "clobbered by the
      // arriving remote snapshot when no persistence ... is attached"), on the assumption that
      // "the real UI only writes after boot paint". That assumption does not hold: the bottom
      // dock's "New note" button is clickable as soon as the shell paints, well before the pull
      // lands. Reproduced deterministically by holding GET /me/notes open and creating inside the
      // window — 6/6 lost, zero POSTs — against 0/24 without the delay.
      //
      // WEB ONLY in effect: desktop passes a persistence plugin, whose retrySync bookkeeping
      // survives the snapshot. Web runs in-memory, so nothing does. Publishing late costs a beat
      // of the loading state the synchronized hooks already render for a null store.
      await whenWaveOneLoaded(created);
      if (cancelled) return;
      setStore(created);
    })();
    return () => {
      cancelled = true;
      created?.dispose();
      setStore(null);
    };
  }, [accountId, sessionKey, orgId, platform, auth]);

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
