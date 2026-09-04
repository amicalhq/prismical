/**
 * NoteBodyStore + CollabBridge — the persistence half of
 * the note-body log lane, structured exactly like domains/transport/service.ts:
 * a WORKSPACE-scoped store over the ProductDb (both branches mount one — local
 * over local.db, cloud over the per-(sub, org) cache) plus the BOOT-scoped
 * bridge the CollabBroker reads it through.
 *
 * Main never decodes Yjs: `update` blobs are opaque bytes appended/replayed in
 * seq order; the derived read-model (contentText/contentMarkdown/firstLine)
 * arrives pre-computed from the renderer's flush (the renderer already holds
 * the live doc — deriving there avoids a second schema round-trip in main).
 */
import { Context, type Effect, type Option, type Scope } from 'effect';
import type { ProductDbError } from '../../infra/product-db/service';

/** One persisted log row, replayed in `seq` order to rebuild the doc. */
export interface NoteBodyUpdateRow {
  readonly seq: number;
  /** Raw Yjs update payload — opaque to main. */
  readonly update: Uint8Array;
}

/** The renderer-derived body read-model applied by a flush. */
export interface NoteBodyFlush {
  readonly text: string;
  readonly markdown: string | null;
  readonly firstLine: string;
}

export interface NoteBodyStoreApi {
  /** The full update log for a note, ordered by seq ascending. */
  readonly listUpdates: (
    noteId: string
  ) => Effect.Effect<ReadonlyArray<NoteBodyUpdateRow>, ProductDbError>;
  /**
   * Append one update at the next per-note seq (atomic — the seq is allocated
   * inside the INSERT). Lazily creates a stub note row ('Untitled note',
   * titleSource 'placeholder') when none exists yet, mirroring the cloud store
   * hook's lazy create. Returns the assigned seq.
   */
  readonly appendUpdate: (
    noteId: string,
    update: Uint8Array
  ) => Effect.Effect<number, ProductDbError>;
  /**
   * Replace the log prefix seq<=upTo with one merged state row AT seq=upTo
   * (delete + insert in one batch transaction) — rows above upTo survive, so a
   * concurrent append is never lost and replay order stays correct.
   */
  readonly compact: (
    noteId: string,
    upTo: number,
    state: Uint8Array
  ) => Effect.Effect<void, ProductDbError>;
  /**
   * Project the derived read-model onto the note row WITHOUT bumping
   * updatedAt (a body save is not a metadata write). Only live rows whose
   * title comes from the placeholder or first line follow the first line;
   * a CHANGED derived title bumps updatedAt to max(now, current + 1ms) so
   * the sync delta carries it.
   */
  readonly applyFlush: (
    noteId: string,
    content: NoteBodyFlush
  ) => Effect.Effect<void, ProductDbError>;
}

export class NoteBodyStore extends Context.Tag('desktop/NoteBodyStore')<
  NoteBodyStore,
  NoteBodyStoreApi
>() {}

/**
 * The boot-scoped store accessor (the exact analogue of WorkspaceTransport):
 * the workspace-scoped NoteBodyStore self-publishes here on acquire
 * (compare-and-clear on release), so the boot-scoped CollabBroker reaches the
 * live workspace's store — and with no workspace mounted it settles gracefully
 * (NO_WORKSPACE at open, warn+drop mid-session), never a throw.
 */
export interface CollabBridgeApi {
  readonly register: (store: NoteBodyStoreApi) => Effect.Effect<void, never, Scope.Scope>;
  readonly current: Effect.Effect<Option.Option<NoteBodyStoreApi>>;
}

export class CollabBridge extends Context.Tag('desktop/CollabBridge')<
  CollabBridge,
  CollabBridgeApi
>() {}
