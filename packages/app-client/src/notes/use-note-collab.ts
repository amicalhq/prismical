"use client";

import { useEffect, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
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
import { useSyncStore } from "../sync/provider";

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
  doc: Y.Doc | null;
  status: CollabStatus;
  synced: boolean;
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
 * mode it is an offline cache riding beside the unchanged provider. Web never
 * configures a note log and keeps this hook's original behavior exactly.
 */
export function useNoteCollab(noteId: string): NoteCollab {
  const activeOrgId = useActiveOrgId();
  const activeAccountId = useActiveAccountId();
  const activeSessionKey = useActiveSessionKey();
  // The collaboration WSS connect is renderer-direct on both platforms, so the
  // note WS URL comes from the injected EnvPort (desktop supplies its own) and
  // the connect token from the AuthPort (web reads the api/auth seam; desktop
  // fetches a main-owned token per (re)connect) — never env sniffing / the raw
  // token seam directly.
  const { noteWsUrl } = useEnv();
  const { auth } = usePorts();
  const syncStore = useSyncStore();
  const [state, setState] = useState<NoteCollab>({
    doc: null,
    status: "connecting",
    synced: false,
    scope: "read-write",
    error: null,
  });

  useEffect(() => {
    const doc = new Y.Doc();
    setState({ doc, status: "connecting", synced: false, scope: "read-write", error: null });

    // The active organization rides on the connection query string (the WS-transport
    // equivalent of `x-active-org-id`); the note server re-checks it against live
    // membership. Reconnects when the org changes (effect dep below).
    const url = activeOrgId
      ? `${noteWsUrl}?activeOrgId=${encodeURIComponent(activeOrgId)}`
      : noteWsUrl;

    // Gated create: a note minted optimistically in this session must not open its collaboration
    // room until the server acknowledges the metadata create — the note
    // service lazy-creates missing rows with a date-fallback title that would
    // clobber the real one under LWW. Notes not created locally resolve
    // immediately; a stuck create is released by the store's 20s valve.
    let disposed = false;
    let provider: HocuspocusProvider | null = null;
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

    const connect = () => {
      if (disposed) return;
      provider = new HocuspocusProvider({
        url,
        name: noteId,
        token: async () =>
          activeSessionKey
            ? (await auth.getTokenForSession(activeSessionKey, activeOrgId)) ?? ""
            : "",
        document: doc,
        onStatus: ({ status }) =>
          setState((s) => ({ ...s, status: String(status) as CollabStatus })),
        onAuthenticated: ({ scope }) =>
          setState((s) => ({ ...s, scope: scope as CollabScope })),
        onSynced: ({ state: synced }) => {
          if (synced) {
            hasSynced = true;
            authRetries = 0;
          }
          // A successful sync clears a prior auth error (reconnect after the
          // AuthProvider refreshed the token).
          setState((s) => ({ ...s, synced, error: synced ? null : s.error }));
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
          setState((s) => ({ ...s, error: reason || "authentication failed" }));
        },
      });
    };

    const startProvider = () => {
      if (syncStore) void syncStore.whenNoteCreateAcked(noteId).then(connect);
      else connect();
    };

    // --- Desktop note-body log lane -----------------------------------------
    // Deliberately NOT gated on whenNoteCreateAcked: the log lane cannot
    // clobber titles (main's applyFlush follows placeholder/first-line titles
    // only), and gating it would stall local-mode hydration behind a sync ack.
    const noteLog = getNoteLogConfig();
    let logHandle: NoteLogHandle | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushDirty = false;
    let dirtySince = 0;
    let finalFlush: (() => void) | null = null;
    let onPageHide: (() => void) | null = null;
    if (noteLog) {
      const handle = noteLog.open(noteId);
      logHandle = handle;

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
        handle.sendUpdate(update);
        scheduleFlush();
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
          // Local mode has no other authority, so a store that keeps rejecting
          // writes must surface — the user cannot be left typing into a black
          // hole. In cloud mode the log is only an offline cache beside a live
          // provider, so a failing cache degrades quietly instead of replacing
          // a perfectly working editor with a lock card.
          if (!noteLog.remote) {
            setState((s) => ({ ...s, error: "note log writes failing" }));
          }
          return;
        }
        if (now - lastHealAt < NOTE_LOG_RESYNC_MIN_INTERVAL_MS) return;
        lastHealAt = now;
        void handle.hydrated.then(({ seq }) => {
          if (disposed) return;
          handle.compact(seq, Y.encodeStateAsUpdate(doc));
        });
      });

      // A failed open is terminal for this lane. LOCAL mode must NOT fall back
      // to the provider: connecting would dial the packaged cloud collab WSS
      // from a mode whose whole premise is "no server". Surface the failure
      // instead — NoteBodyEditor renders its generic lock card on any
      // non-empty `error` (it ignores the content). Cloud mode keeps the
      // provider attached below and simply runs without the offline cache.
      const failOpen = (reason: string) => {
        if (disposed || noteLog.remote) return;
        setState((s) => ({ ...s, status: "disconnected", synced: false, error: reason }));
      };

      handle.opened.then(
        (result) => {
          if (disposed) return;
          if ("error" in result) {
            failOpen(`note log unavailable: ${result.error.code}`);
            return;
          }
          void handle.hydrated.then(({ seq, count }) => {
            if (disposed) return;
            // Local mode has no server: hydration IS the sync point.
            if (!noteLog.remote) {
              setState((s) => ({
                ...s,
                status: "connected",
                synced: true,
                scope: "read-write",
                error: null,
              }));
            }
            if (count > NOTE_LOG_COMPACT_THRESHOLD) {
              handle.compact(seq, Y.encodeStateAsUpdate(doc));
            }
          });
        },
        () => failOpen("note log unavailable"),
      );
    }

    // No note log (web, byte-identical) or cloud mode (the log is a cache
    // beside the provider): attach the provider exactly as before.
    if (!noteLog || noteLog.remote) startProvider();

    return () => {
      disposed = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (onPageHide) window.removeEventListener("pagehide", onPageHide);
      // Final projection of unflushed local edits, BEFORE the doc is destroyed
      // (the port outlives this tick — queued messages still deliver).
      if (flushDirty) finalFlush?.();
      logHandle?.close();
      if (retryTimer) clearTimeout(retryTimer);
      provider?.destroy();
      doc.destroy();
    };
    // Reconnect on org OR account change — a new account reconnects under its own
    // exact-context token, preventing the prior account's WS session
    // from lingering open over this note. `noteWsUrl`/`auth` are session-stable.
    //
    // `syncStore` is deliberately NOT a dep, preserving the behaviour this hook has always had.
    // Listing it would tear down and reopen a live collab session every time the store identity
    // changes, which is a worse trade than the gate it would re-apply.
    //
    // Pre-existing hazard this does NOT fix, recorded so it isn't rediscovered from scratch:
    // SyncStoreProvider nulls the store on every identity change and the replacement starts with
    // an empty `locallyCreatedNotes`. A note whose create has NOT yet been acked, mounting across
    // that swap, therefore passes the gate instantly — the note service lazy-creates the row with
    // a date-fallback title and LWW clobbers the real one, which is the exact case the gate
    // exists to prevent. Fixing it means surviving the swap, not adding a dep here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, activeOrgId, activeAccountId, activeSessionKey, noteWsUrl, auth]);

  return state;
}
