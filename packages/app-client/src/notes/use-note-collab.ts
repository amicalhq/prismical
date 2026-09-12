"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useSelector } from '@legendapp/state/react';
import type { NoteLogHandle } from "@prismical/app-contracts";
import { deriveNoteContentFromYDoc } from "@prismical/note-derive";
import {
  useActiveAccountId,
  useActiveOrgId,
  useActiveSessionKey,
  useEnv,
  usePorts,
} from "../ports-context";
import { getNoteLogConfig } from "../runtime";
import { startLoadingTiming } from "../loading-timing";
import { useSyncStore } from "../sync/provider";
import { BodyCache, registerOpenBody } from './body-cache';
import { openIndexedDbNoteLog } from './indexeddb-note-log';

export type CollabStatus = "connecting" | "connected" | "disconnected";
export type CollabScope = "read-write" | "readonly";

/** Debounce for projecting the derived read model after local edits. */
const NOTE_LOG_FLUSH_DEBOUNCE_MS = 1000;
/**
 * Ceiling on that debounce: continuous typing re-arms the timer on every doc
 * update, so without a max wait a long burst would never project the read
 * model (title-follow, excerpt, FTS) at all.
 */
const NOTE_LOG_FLUSH_MAX_WAIT_MS = 5000;
/** Replay length beyond which the log is compacted to one merged state row. */
const NOTE_LOG_COMPACT_THRESHOLD = 200;
/** Minimum spacing between resync heals — each one re-snapshots the whole doc. */
const NOTE_LOG_RESYNC_MIN_INTERVAL_MS = 2000;
/** Resyncs this close together mean the store is persistently rejecting writes. */
const NOTE_LOG_RESYNC_WINDOW_MS = 30000;
const NOTE_LOG_RESYNC_MAX = 3;

export interface NoteCollab {
  /** Keep a temporary editor alive until its local changes reach the collaboration server. */
  waitForPendingChanges: () => Promise<void>;
  /** Read the live provider permission without waiting for React to publish its next render. */
  hasWriteAccess: () => boolean;
  /** Correlates passive editor phases with this document's collaboration mount. */
  loadingAttemptId?: string;
  doc: Y.Doc | null;
  status: CollabStatus;
  synced: boolean;
  /** A new or cached body has hydrated locally; independent of remote delivery. */
  ready: boolean;
  localSaved: boolean;
  localSaveError: string | null;
  remotePending: boolean;
  waitForLocalChanges: () => Promise<void>;
  /**
   * The server's authoritative per-connection scope (from onAuthenticated).
   * A read-only member's connection is flagged `readonly` and Hocuspocus
   * silently DROPS its edits — so the editor must lock on this, not just on
   * core's cached `canWrite` snapshot (which can be stale after a revocation).
   */
  scope: CollabScope;
  /**
   * Set when the server rejects the connection — no read access, or an
   * invalid/expired token (server `onAuthenticate` throws). Without this, a
   * rejected connection never emits `synced` and the UI would spin forever.
   * Cleared if a later reconnect (e.g. with a refreshed token) syncs.
   */
  error: string | null;
}

/**
 * Owns one Y.Doc + HocuspocusProvider per note. Reconnects automatically; the
 * token callback returns the live id_token (refreshed by AuthProvider) so a
 * reconnect after expiry uses a fresh token. Tears everything down on unmount
 * and when `noteId` changes.
 *
 * Desktop additionally opens the main-process note-body log through
 * the injected NoteLogConfig: main replays the persisted Yjs update log into
 * the doc, local edits stream back for append + cross-window relay, and a
 * debounced flush projects the derived read-model. In local mode the log IS
 * the collab lane (hydration flips the state to connected/synced); in cloud
 * mode it persists beside the provider. Web uses the same log contract over
 * IndexedDB. Local hydration and remote delivery are separate readiness states.
 */
export function useNoteCollab(noteId: string, options: { background?: boolean } = {}): NoteCollab {
  const background = options.background ?? false;
  const [logRetryEpoch, retryLog] = useState(0);
  const logStartup = useRef<{ identity: string; startedAt: number } | null>(null);
  const waitForPendingChangesRef = useRef<() => Promise<void>>(() =>
    Promise.reject(new Error('The note connection is unavailable.'))
  );
  const waitForPendingChanges = useCallback(() => waitForPendingChangesRef.current(), []);
  const hasWriteAccessRef = useRef<() => boolean>(() => false);
  const hasWriteAccess = useCallback(() => hasWriteAccessRef.current(), []);
  const waitForLocalChangesRef = useRef<() => Promise<void>>(() => Promise.reject(new Error('Local note storage unavailable')));
  const waitForLocalChanges = useCallback(() => waitForLocalChangesRef.current(), []);
  const activeOrgId = useActiveOrgId();
  const activeAccountId = useActiveAccountId();
  const activeSessionKey = useActiveSessionKey();
  // The collaboration WSS connect is renderer-direct on both platforms, so the
  // note WS URL comes from the injected EnvPort (desktop supplies its own) and
  // the connect token from the AuthPort (web reads the api/auth seam; desktop
  // fetches a main-owned token per (re)connect) — never env sniffing / the raw
  // token seam directly.
  const { noteWsUrl, platform } = useEnv();
  const { auth, analytics } = usePorts();
  const analyticsRef = useRef(analytics);
  analyticsRef.current = analytics;
  const syncStore = useSyncStore();
  const metadataSaveError = useSelector(() => syncStore?.persistenceError$?.get() ?? null);
  const [state, setState] = useState<Omit<NoteCollab, 'waitForPendingChanges' | 'hasWriteAccess' | 'waitForLocalChanges'>>({
    doc: null,
    status: "connecting",
    synced: false,
    ready: false,
    localSaved: false,
    localSaveError: null,
    remotePending: true,
    scope: "read-write",
    error: null,
  });

  useEffect(() => {
    const timing = startLoadingTiming(analyticsRef.current, "note_collaboration", noteId);
    const doc = new Y.Doc();
    const identity = `${activeAccountId}:${activeSessionKey}:${activeOrgId}:${noteId}`;
    const sameStartup = logStartup.current?.identity === identity;
    if (!sameStartup) logStartup.current = { identity, startedAt: Date.now() };
    setState(previous => ({ doc, status: "connecting", synced: false, ready: false, localSaved: false,
      localSaveError: sameStartup ? previous.localSaveError : null, remotePending: true, scope: "read-write",
      error: sameStartup ? previous.error : null, loadingAttemptId: timing.attemptId }));
    const configuredLog = getNoteLogConfig();
    const partition = activeAccountId ? { accountSub: activeAccountId, orgId: activeOrgId ?? '' } : null;
    const cache = partition && typeof indexedDB !== 'undefined' && configuredLog?.remote !== false
      ? new BodyCache(partition) : null;
    const unregister = partition && !background ? registerOpenBody(partition, noteId) : null;
    const noteAtOpen = syncStore?.notes$[noteId]?.peek();
    const createdLocally = !!noteAtOpen && !noteAtOpen.createdAt;
    let bodyHydrated = !configuredLog && !(platform === 'web' && cache);
    let indexedRevision = 0;
    let unseenCacheChanges = false;
    let localRevision = 0;
    let indexWrites: Promise<unknown> = cache?.update(noteId, row => ({
      ...row, initialized: row.initialized || createdLocally,
    })).then(row => { indexedRevision = row.revision; }) ?? Promise.resolve();

    // The active organization rides on the connection query string (the WS-transport
    // equivalent of `x-active-org-id`); the note server re-checks it against live
    // membership. Reconnects when the org changes (effect dep below).
    const url = activeOrgId
      ? `${noteWsUrl}?activeOrgId=${encodeURIComponent(activeOrgId)}`
      : noteWsUrl;

    // Local editing has no network gate. Remote collaboration requires actual
    // metadata acknowledgement, including after restart; cancellation never releases it.
    let disposed = false;
    let logRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const abort = new AbortController();
    let provider: HocuspocusProvider | null = null;
    let persistLocal: () => Promise<void> = platform === 'web' && activeAccountId && !cache
      ? () => Promise.reject(new Error('Local note storage unavailable')) : () => Promise.resolve();
    const storageFailed = (error: unknown) => {
      if (!disposed) setState(s => ({ ...s, localSaved: false, localSaveError: error instanceof Error ? error.message : 'Local note storage failed' }));
    };
    void indexWrites.catch(storageFailed);
    const saveLocal = async () => {
      const revision = localRevision;
      await indexWrites;
      await persistLocal();
      if (!disposed && revision === localRevision) setState(s => ({ ...s, localSaved: true, localSaveError: null }));
    };
    waitForLocalChangesRef.current = async () => {
      if (disposed) throw new Error('The note connection is unavailable.');
      await saveLocal();
    };
    const remoteDelivered = () => {
      const connection = provider;
      if (!connection?.synced || connection.hasUnsyncedChanges) return;
      const revision = localRevision;
      void saveLocal().then(async () => {
        if (disposed || provider !== connection || connection.hasUnsyncedChanges || revision !== localRevision) return;
        if (cache) {
          // Another window can persist edits this document has not replayed.
          // A skipped revision keeps the body dirty until a fresh session hydrates it.
          const row = await cache.markSynced(noteId, unseenCacheChanges ? -1 : indexedRevision, connection.authorizedScope === 'read-write');
          if (!disposed && localRevision === revision) setState(s => ({ ...s, remotePending: row.dirty }));
        }
      }).catch(storageFailed);
    };
    const pendingWaits = new Set<() => void>();
    hasWriteAccessRef.current = () => !disposed && !!provider?.isAuthenticated &&
      provider.authorizedScope === 'read-write';
    waitForPendingChangesRef.current = () => {
      const connection = provider;
      if (disposed || !connection) return Promise.reject(new Error('The note connection is unavailable.'));
      const delivered = () => connection.synced && !connection.hasUnsyncedChanges;
      if (delivered()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          connection.off('unsyncedChanges', onChanges);
          connection.off('synced', onChanges);
          connection.off('destroy', onDisposed);
          pendingWaits.delete(onDisposed);
          if (error) reject(error);
          else resolve();
        };
        const onChanges = () => {
          if (delivered()) finish();
        };
        const onDisposed = () => finish(new Error('The note connection closed.'));
        const timer = setTimeout(() => finish(new Error('The note changes have not synced yet.')), 15_000);
        pendingWaits.add(onDisposed);
        connection.on('unsyncedChanges', onChanges);
        connection.on('synced', onChanges);
        connection.on('destroy', onDisposed);
        onChanges();
      });
    };
    // Rotation-aware auth-failure handling: the note server periodically
    // rotates collab sockets, so
    // re-authentication is now a routine mid-session event. The provider does
    // NOT retry after a permission-denied (it leaves the socket open and
    // schedules nothing), so a transient token blip on a rotation reconnect
    // would otherwise latch `error` and replace the editor with a lock card.
    // After a session has synced once, redial with a fresh token instead, and
    // only surface the error after repeated consecutive failures.
    let hasSynced = false;
    let authRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_AUTH_RETRIES = 3;
    let connectionAttempt = 0;
    let lastStatus = "connecting";

    const connect = () => {
      if (disposed) return;
      timing.mark("create_gate_released");
      connectionAttempt++;
      lastStatus = "connecting";
      timing.mark("provider_constructing", connectionAttempt);
      provider = new HocuspocusProvider({
        url,
        name: noteId,
        token: async () => {
          const tokenAttempt = connectionAttempt;
          timing.mark("token_requested", tokenAttempt);
          const token = activeSessionKey
            ? (await auth.getTokenForSession(activeSessionKey, activeOrgId)) ?? ""
            : "";
          timing.mark("token_resolved", tokenAttempt);
          if (!token) timing.mark("token_missing", tokenAttempt);
          return token;
        },
        document: doc,
        onStatus: ({ status }) => {
          if (status === "connecting" && lastStatus !== "connecting") connectionAttempt++;
          lastStatus = String(status);
          if (status === "connecting") timing.mark("socket_connecting", connectionAttempt);
          if (status === "connected") timing.mark("socket_connected", connectionAttempt);
          setState((s) => ({ ...s, status: String(status) as CollabStatus }));
        },
        onAuthenticated: ({ scope }) => {
          timing.mark("authenticated", connectionAttempt);
          setState((s) => ({ ...s, scope: scope as CollabScope }));
          if (cache) {
            indexWrites = indexWrites.catch(() => {}).then(() => cache.update(noteId, row => ({ ...row, scope: scope as CollabScope })));
            void indexWrites.catch(storageFailed);
          }
        },
        onSynced: ({ state: synced }) => {
          if (synced) {
            timing.mark("document_synced", connectionAttempt);
            timing.finish("ready");
            hasSynced = true;
            authRetries = 0;
          }
          // A successful sync clears a prior auth error (reconnect after the
          // AuthProvider refreshed the token).
          setState((s) => ({ ...s, synced, ready: s.ready || (synced && bodyHydrated), error: synced ? null : s.error }));
          if (synced) remoteDelivered();
        },
        onUnsyncedChanges: ({ number }) => {
          setState(s => ({ ...s, remotePending: number > 0 }));
          remoteDelivered();
        },
        onAuthenticationFailed: ({ reason }) => {
          if (hasSynced && authRetries < MAX_AUTH_RETRIES) {
            authRetries += 1;
            retryTimer = setTimeout(() => {
              if (disposed) return;
              provider?.destroy();
              connect();
            }, 2000 * authRetries);
            return;
          }
          timing.finish("error");
          setState((s) => ({ ...s, error: reason || "authentication failed" }));
        },
      });
      timing.mark("provider_constructed", connectionAttempt);
    };

    const startProvider = () => {
      timing.mark("create_gate_waiting");
      if (syncStore) void syncStore.requireNoteCreateAck(noteId, Infinity, abort.signal).then(async () => {
        const connectAuthenticated = async () => {
          if (disposed) return;
          const token = activeSessionKey ? await auth.getTokenForSession(activeSessionKey, activeOrgId).catch(() => null) : null;
          if (disposed) return;
          if (token) connect();
          else {
            setState(s => ({ ...s, status: 'disconnected' }));
            retryTimer = setTimeout(() => { void connectAuthenticated(); }, 5000);
          }
        };
        await connectAuthenticated();
      }).catch(error => {
        if (!disposed) setState(s => ({ ...s, error: error instanceof Error ? error.message : 'Note creation rejected' }));
      });
    };

    // --- Desktop note-body log lane -----------------------------------------
    // Deliberately NOT gated on whenNoteCreateAcked: the log lane cannot
    // clobber titles (main's applyFlush follows placeholder/first-line titles
    // only), and gating it would stall local-mode hydration behind a sync ack.
    const noteLog = configuredLog ?? (platform === 'web' && cache
      ? { remote: true, open: (id: string) => openIndexedDbNoteLog(cache, id) } : null);
    let logHandle: NoteLogHandle | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushDirty = false;
    let dirtySince = 0;
    let finalFlush: (() => void) | null = null;
    let onPageHide: (() => void) | null = null;
    if (noteLog) {
      const handle = noteLog.open(noteId);
      logHandle = handle;
      persistLocal = () => handle.waitForPendingChanges();
      let logHydrated = false;
      let logFailed = false;

      const flushNow = () => {
        flushDirty = false;
        try {
          // Markdown failure is isolated inside the derivation (markdown
          // degrades to null); a schema-parity throw skips this flush entirely
          // — the append-only log still holds the authoritative doc.
          const derived = deriveNoteContentFromYDoc(doc, {
            onMarkdownError: (err) =>
              console.warn("[note-log] markdown derivation failed", err),
          });
          handle.flush({
            text: derived.text,
            markdown: derived.markdown,
            firstLine: derived.firstLine,
          });
        } catch (err) {
          console.warn("[note-log] flush derivation failed", err);
        }
      };
      finalFlush = flushNow;
      if (!noteLog.remote) {
        const writable = () => !disposed && logHydrated && !logFailed;
        hasWriteAccessRef.current = writable;
        waitForPendingChangesRef.current = async () => {
          if (!writable()) throw new Error('The note connection is unavailable.');
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = null;
          // Retry the projection too: an earlier flush may have failed in main.
          flushNow();
          await handle.waitForPendingChanges();
          if (!writable()) throw new Error('The note connection is unavailable.');
        };
      }
      const scheduleFlush = () => {
        const now = Date.now();
        if (!flushDirty) dirtySince = now;
        flushDirty = true;
        if (flushTimer) clearTimeout(flushTimer);
        // Max-wait ceiling: uninterrupted typing (≥1 update/sec) would re-arm
        // the debounce forever, so once the doc has been dirty this long,
        // project NOW instead of re-arming.
        if (now - dirtySince >= NOTE_LOG_FLUSH_MAX_WAIT_MS) {
          flushTimer = null;
          flushNow();
          return;
        }
        flushTimer = setTimeout(flushNow, NOTE_LOG_FLUSH_DEBOUNCE_MS);
      };
      // React cleanup never runs on a window close / ⌘Q: project the pending
      // edit burst best-effort while the renderer is still alive.
      onPageHide = () => {
        if (flushDirty) flushNow();
      };
      window.addEventListener("pagehide", onPageHide);

      // Replayed + relayed blobs apply under the 'notelog' origin so the doc
      // subscription below never echoes them back to main.
      handle.onUpdate((update) => {
        if (disposed) return;
        Y.applyUpdate(doc, update, "notelog");
      });
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === "notelog") return;
        localRevision++;
        setState(s => ({ ...s, localSaved: false }));
        if (cache) indexWrites = indexWrites.catch(() => {}).then(async () => {
          const row = await cache.markChanged(noteId, origin !== provider);
          if (row.revision !== indexedRevision + 1) unseenCacheChanges = true;
          indexedRevision = row.revision;
        });
        handle.sendUpdate(update);
        scheduleFlush();
        void saveLocal().then(remoteDelivered).catch(storageFailed);
      });

      // Resync: main could not durably append an update, so the log has a gap
      // that makes every LATER update unapplicable on replay. Heal it by
      // re-seeding the hydrated prefix with a full state snapshot — compacting
      // at the hydrated seq deletes that prefix and re-inserts the snapshot
      // there, while rows appended after it survive and re-apply idempotently.
      // Throttled (each heal ships the whole doc); a persistent failure stops
      // healing and surfaces the error instead of letting the user keep typing
      // into a store that is not accepting writes.
      let lastHealAt = 0;
      let resyncWindowStart = 0;
      let resyncCount = 0;
      handle.onResync(() => {
        if (disposed) return;
        const now = Date.now();
        if (now - resyncWindowStart > NOTE_LOG_RESYNC_WINDOW_MS) {
          resyncWindowStart = now;
          resyncCount = 0;
        }
        resyncCount += 1;
        if (resyncCount >= NOTE_LOG_RESYNC_MAX) {
          // Keep the cloud document visible for recovery, but never claim a
          // failed local write is saved. Local mode has no other authority.
          storageFailed(new Error('Local note storage is not accepting writes'));
          if (!noteLog.remote) {
            logFailed = true;
            setState((s) => ({ ...s, error: "note log writes failing" }));
          }
          return;
        }
        if (now - lastHealAt < NOTE_LOG_RESYNC_MIN_INTERVAL_MS) return;
        lastHealAt = now;
        void handle.hydrated.then(({ seq }) => {
          if (disposed) return;
          handle.compact(seq, Y.encodeStateAsUpdate(doc));
        }).catch(storageFailed);
      });

      // A failed open is terminal for this lane. LOCAL mode must NOT fall back
      // to the provider: connecting would dial the packaged cloud collab WSS
      // from a mode whose whole premise is "no server". Surface the failure
      // instead — NoteBodyEditor renders its generic lock card on any
      // non-empty `error` (it ignores the content). Cloud mode keeps the
      // provider attached below and simply runs without the offline cache.
      const failOpen = (reason: string) => {
        if (disposed) return;
        storageFailed(new Error(reason));
        if (noteLog.remote) return;
        logFailed = true;
        timing.finish("error");
        setState((s) => ({ ...s, status: "disconnected", synced: false, error: reason }));
      };

      handle.opened.then(
        (result) => {
          if (disposed) return;
          if ("error" in result) {
            // Desktop opens its windows before the workspace database finishes
            // mounting. Only this explicit startup result is retryable. The
            // editor has not been published, so no user edits can be discarded.
            if (configuredLog && result.error.code === 'NO_WORKSPACE' && !bodyHydrated) {
              if (Date.now() - logStartup.current!.startedAt >= 5000) failOpen('note log unavailable: NO_WORKSPACE');
              logRetryTimer = setTimeout(() => { if (!disposed) retryLog(epoch => epoch + 1); }, 1000);
              return;
            }
            failOpen(`note log unavailable: ${result.error.code}`);
            return;
          }
          void handle.hydrated.then(async ({ seq, count }) => {
            if (disposed) return;
            await indexWrites;
            const cached = cache ? await cache.get(noteId) : null;
            if (disposed) return;
            if (cached?.scope && !provider?.isAuthenticated) setState(s => ({ ...s, scope: cached.scope! }));
            logHydrated = true;
            bodyHydrated = true;
            if (!noteLog.remote || createdLocally || cached?.initialized || hasSynced || (configuredLog && count > 0)) {
              if (cache) await cache.update(noteId, row => ({ ...row, initialized: true }));
              if (disposed) return;
              setState(s => ({ ...s, ready: true }));
            }
            await saveLocal();
            // Local mode has no server: hydration IS the sync point.
            if (!noteLog.remote) {
              logHydrated = true;
              timing.mark("local_log_hydrated");
              timing.finish("ready");
              setState((s) => ({
                ...s,
                status: "connected",
                synced: true,
                remotePending: false,
                scope: "read-write",
                error: null,
              }));
            }
            if (count > NOTE_LOG_COMPACT_THRESHOLD) {
              handle.compact(seq, Y.encodeStateAsUpdate(doc));
            }
          }).catch(error => failOpen(error instanceof Error ? error.message : 'note log unavailable'));
        },
        () => failOpen("note log unavailable"),
      );
    }

    // Local desktop workspaces have no remote provider.
    if (!noteLog || noteLog.remote) startProvider();
    if (!noteLog && platform === 'web' && activeAccountId) storageFailed(new Error('Local note storage unavailable'));

    return () => {
      disposed = true;
      if (logRetryTimer) clearTimeout(logRetryTimer);
      abort.abort();
      unregister?.();
      for (const cancel of [...pendingWaits]) cancel();
      timing.finish("abandoned");
      if (flushTimer) clearTimeout(flushTimer);
      if (onPageHide) window.removeEventListener("pagehide", onPageHide);
      // Final projection of unflushed local edits, BEFORE the doc is destroyed
      // (the port outlives this tick — queued messages still deliver).
      if (flushDirty) finalFlush?.();
      const localDrain = persistLocal();
      void Promise.allSettled([indexWrites, localDrain]).then(() => {
        logHandle?.close();
        cache?.close();
      });
      if (retryTimer) clearTimeout(retryTimer);
      provider?.destroy();
      doc.destroy();
    };
    // Reconnect on org OR account change — a new account reconnects under its own
    // exact-context token, preventing the prior account's WS session
    // from lingering open over this note. `noteWsUrl`/`auth` are session-stable.
  }, [noteId, activeOrgId, activeAccountId, activeSessionKey, noteWsUrl, auth, platform, background, syncStore, logRetryEpoch]);

  return {
    ...state,
    localSaveError: metadataSaveError?.message ?? state.localSaveError,
    localSaved: !metadataSaveError && state.localSaved,
    waitForPendingChanges, waitForLocalChanges, hasWriteAccess,
  };
}
