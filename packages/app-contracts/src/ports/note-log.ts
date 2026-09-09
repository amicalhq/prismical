// NoteLog — the desktop note-body log lane.
//
// Mirrors the desktop IPC collab surface (packages/desktop-contracts/
// src/main-window.ts CollabOpenResponse + the collab port vocabulary)
// field-for-field — types only, no zod (app-contracts is runtime-dep-free;
// see ports/transport.ts for the mirror rationale). The desktop mount injects
// a NoteLogConfig via configureAppClient; web never configures one, keeping
// its collab path byte-identical. `useNoteCollab` opens one handle per note:
// main replays the persisted Yjs update log (each blob via onUpdate, then the
// hydrated marker), appends/relays sendUpdate blobs across windows, and
// projects flush/compact into the product store.

export type NoteLogOpenResult =
  | { readonly ok: true }
  | { readonly error: { readonly code: string; readonly message?: string } };

/** The hydrated marker: the log's last seq + how many updates were replayed. */
export interface NoteLogHydration {
  readonly seq: number;
  readonly count: number;
}

/** The renderer-derived body read-model a flush projects into the store. */
export interface NoteLogFlush {
  readonly text: string;
  readonly markdown: string | null;
  readonly firstLine: string;
}

export interface NoteLogHandle {
  /** Resolves/rejects with main's open result — no port ever arrives on an error. */
  readonly opened: Promise<NoteLogOpenResult>;
  /** Resolves once the full log replay has been delivered through onUpdate. */
  readonly hydrated: Promise<NoteLogHydration>;
  /** Subscribe to update blobs (replayed AND relayed); buffered until first set. */
  readonly onUpdate: (callback: (update: Uint8Array) => void) => void;
  /**
   * Subscribe to the resync signal: an append did NOT reach the store, so the
   * log has a gap that makes every later update unapplicable on replay. The
   * consumer heals it by compacting a full state snapshot over the hydrated
   * prefix.
   */
  readonly onResync: (callback: () => void) => void;
  /** Append one local Yjs update to the log (relayed to other windows by main). */
  readonly sendUpdate: (update: Uint8Array) => void;
  /** Project the derived read-model onto the note row (never bumps updatedAt). */
  readonly flush: (content: NoteLogFlush) => void;
  /** Wait until preceding updates and flushes are durable; reject a failed write or closed port. */
  readonly waitForPendingChanges: () => Promise<void>;
  /** Replace the log prefix seq<=upTo with one merged state row at seq=upTo. */
  readonly compact: (upTo: number, state: Uint8Array) => void;
  readonly close: () => void;
}

export interface NoteLogConfig {
  readonly open: (noteId: string) => NoteLogHandle;
  /**
   * True in cloud mode: the Hocuspocus provider still attaches (the log lane
   * is an offline cache beside it) and remains the authority for
   * status/synced/scope. False in local mode: hydration alone flips the
   * collab state to connected/synced (there is no server).
   */
  readonly remote: boolean;
}
