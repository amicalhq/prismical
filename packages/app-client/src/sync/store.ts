/**
 * The Legend-State sync store — the client-side synchronized data plane
 * collections (notes, folders, tags, note-tags) as `syncedCrud` observables
 * over the vetted wire layer (./api.ts), one store instance per
 * (account, org) partition.
 *
 * Mirrors the conventions of Prismical's vetted mobile sync adapter (the
 * REFERENCE implementation); the load-bearing conventions it encodes are
 * re-implemented here against our own wire layer and standards:
 *
 *  - `changesSince: 'last-sync'` delta pulls; `fieldUpdatedAt/CreatedAt/Deleted`
 *    = the engine's column trio; `as: 'object'` keyed by id; `updatePartial`
 *    so a starred-toggle never re-PUTs a stale title under whole-row LWW.
 *  - Optimistic rows omit `createdAt` → syncedCrud routes the write to POST
 *    (the server's PUT 404s unknown ids); the server echo backfills it.
 *  - Ids are client-minted via @prismical/id (the engine validates prefixes;
 *    a client id is the create's idempotency key).
 *  - `retry: { infinite: true }` for network/5xx; `terminal4xx` drops +
 *    REVERTS deterministic server rejections so they neither stall the queue
 *    nor strand diverged local state (404-on-delete keeps the tombstone).
 *  - note-tags links gate on their parents' server ack (`waitForSet`) and use
 *    the synthesized composite id.
 *  - Gated note create: a note's collaboration room must not open until
 *    the server acknowledges the metadata create — the note service lazy-creates
 *    rows with a date-fallback title that would clobber the real one under
 *    LWW. `whenNoteCreateAcked` is the per-store gate used by the editor-open
 *    path.
 *
 * Persistence is injected (IndexedDB per partition database on desktop —
 * see partition.ts; none on web today). Pull cadence beyond Legend's
 * on-activation sync is the caller-driven poller (`startPolling`): interval +
 * window focus + `online`, all delta `sync()` — NO scheduled full refresh
 * (by design; `reset()` is rebuild/sign-out-only).
 */
import { observable, syncState, type Observable } from "@legendapp/state";
import type { WaitForSetFnParams } from "@legendapp/state";
import { createRevertChanges } from "@legendapp/state/sync";
import type { SyncedGetParams, SyncedSetParams } from "@legendapp/state/sync";
import { syncedCrud } from "@legendapp/state/sync-plugins/crud";
import type { ObservablePersistPlugin } from "@legendapp/state/sync";
import { createId } from "@prismical/id";
import { ApiError } from "../api/client";
import {
  restCreate,
  restList,
  restNoteEventCreate,
  restNoteEventList,
  restNoteEventRemove,
  restNoteTagCreate,
  restNoteTagList,
  restNoteTagRemove,
  restRemove,
  restUpdate,
} from "./api";
import type { SyncRequestOptions } from "./api";
import { partitionDatabaseName, type SyncPartition, type SyncTableName } from "./partition";
import { sanitizeTagNameInput } from "./tag-name";

// ── Row types (the server's list-lane wire shapes, stored verbatim) ──

/**
 * Note METADATA row. The list lane joins per-caller derived fields
 * (excerpt/folderName/isOwner/canWrite/sharedByName) onto the raw note row;
 * write echoes are the RAW row only, and Legend's response merge assigns
 * returned fields while leaving absent ones untouched — so derived fields
 * survive write echoes and refresh on the next pull. `contentText` (the full
 * markdown body) is synced (`includeBody=1`) because copy-as-markdown and
 * Ask-context consume it. Previews still ride `excerpt`.
 */
/**
 * Timestamp fields: pulled rows carry ISO strings; after a WRITE ECHO, Legend's
 * own saved-bookkeeping converts `createdAt` to a Date (verified against the
 * pinned build — updatedAt stays a string). Consumers must treat these as
 * `string | Date` and compare via `new Date(x)`; JSON/structured-clone
 * round-trips are safe either way.
 */
export type SyncTimestamp = string | Date;

export interface NoteRow {
  id: string;
  titleIntent?: "default";
  titleSource?: string;
  titleRevision?: number;
  title?: string | null;
  contentText?: string | null; // markdown body (includeBody=1); absent only on optimistic creates
  excerpt?: string | null;
  folderName?: string | null;
  isOwner?: boolean;
  canWrite?: boolean;
  sharedByName?: string | null;
  iconUrl?: string | null;
  starred?: boolean;
  folderId?: string | null;
  eventId?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt?: SyncTimestamp; // server-assigned; ABSENT on optimistic rows (create → POST routing)
  updatedAt: SyncTimestamp;
  deletedAt?: string | null;
}

export interface FolderRow {
  id: string;
  name: string;
  parentId?: string | null;
  iconUrl?: string | null;
  isFavorite?: boolean;
  meta?: Record<string, unknown> | null;
  createdAt?: SyncTimestamp;
  updatedAt: SyncTimestamp;
  deletedAt?: string | null;
}

export interface TagRow {
  id: string;
  name: string;
  color: string;
  isFavorite?: boolean;
  createdAt?: SyncTimestamp;
  updatedAt: SyncTimestamp;
  deletedAt?: string | null;
}

/** Composite-key junction row; `id = noteId:tagId` (synthesized at the wire). */
/** A note↔calendar-event link as the store holds it (Legend key `noteId:eventKey`). */
export interface NoteEventRow {
  id: string;
  /** Server row id; absent on an optimistic link until its create is acked. */
  linkId?: string;
  noteId: string;
  eventKey: string;
  seriesKey?: string;
  /** MY own event row for this event (server-resolved per reader), or null when I hold none. */
  eventId: string | null;
  isPrimary: boolean;
  source: "user" | "auto" | "api";
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  meetingUrl: string | null;
  createdAt?: SyncTimestamp;
  updatedAt: SyncTimestamp;
  deletedAt?: string | null;
}

export interface NoteTagRow {
  id: string;
  noteId: string;
  tagId: string;
  addedAt?: string;
  createdAt?: SyncTimestamp;
  updatedAt: SyncTimestamp;
  deletedAt?: string | null;
}

const nowIso = (): string => new Date().toISOString();

// ── Terminal 4xx (don't stall the push queue, don't strand state) ──
// retry:{infinite:true} is right for network/5xx and wrong for deterministic
// rejections: a 409/400 can never succeed on retry and would head-of-line-block
// every queued write. Resolving null settles the op; because a dropped op would
// otherwise leave the optimistic value diverged FOREVER (deltas never re-send
// an untouched server row), the drop also REVERTS the local change — applied as
// a remote change via createRevertChanges, so the revert persists but is not
// pushed. Exception: 404 on a delete means already-gone — the local tombstone
// is correct, keep it. 401 (auth can recover), 408, 429 stay retryable.
function terminal4xx<T>(
  collection: string,
  op: "create" | "update" | "delete",
  params: SyncedSetParams<T>,
  onDropped?: () => void,
) {
  return (error: unknown): null => {
    const status = error instanceof ApiError ? error.status : undefined;
    const isTerminal =
      status !== undefined && status >= 400 && status < 500 && ![401, 408, 429].includes(status);
    if (!isTerminal) throw error;
    let reverted = false;
    if (!(op === "delete" && status === 404)) {
      // Defensive: a throwing revert would reject the op back into infinite retry.
      try {
        const changes = (params.changes ?? []).filter(Boolean);
        if (changes.length) {
          createRevertChanges(params.value$, changes)();
          reverted = true;
        }
      } catch (revertError) {
        console.error(`[sync] ${collection} ${op}: failed to revert dropped op`, revertError);
      }
    }
    console.error(
      `[sync] ${collection} ${op} rejected by server (${status}) — op dropped${reverted ? ", local change reverted" : ""}`,
      error,
    );
    onDropped?.();
    return null;
  };
}

export interface SyncStoreOptions {
  readonly partition: SyncPartition;
  /**
   * Persistence plugin for this partition (desktop: observablePersistIndexedDB
   * against partitionDatabaseName(partition) — see createIndexedDbPersistPlugin
   * in persist.ts). null/undefined = in-memory only (web today; node tests).
   */
  readonly persistPlugin?: ObservablePersistPlugin | null;
  /** Poll cadence for startPolling(); 0 disables the interval (focus/online stay). */
  readonly pollIntervalMs?: number;
  /**
   * Called when a write is terminally rejected by the server (terminal4xx drop
   * + revert). The provider wires this to the UI toast lane so a rejected
   * save/delete never fails silently — the parity of the old react-query
   * mutation error toasts.
   */
  readonly onWriteRejected?: (info: {
    collection: string;
    op: "create" | "update" | "delete";
  }) => void;
  /** Web-only exact auth binding. Desktop leaves this absent so main keeps stamping transport auth. */
  readonly getRequestOptions?: () => Promise<SyncRequestOptions>;
}

export interface SyncStore {
  readonly partition: SyncPartition;
  readonly notes$: Observable<Record<string, NoteRow>>;
  readonly folders$: Observable<Record<string, FolderRow>>;
  readonly tags$: Observable<Record<string, TagRow>>;
  readonly noteTags$: Observable<Record<string, NoteTagRow>>;
  readonly noteEvents$: Observable<Record<string, NoteEventRow>>;
  /** Resolves once the note's collab room may open (metadata create acknowledged or not local). */
  whenNoteCreateAcked(id: string, timeoutMs?: number): Promise<void>;
  /** Delta re-pull of every collection (manual re-sync / poller tick). */
  refreshAll(): Promise<unknown>;
  /** Clear rows + cursor + pending for every collection (sign-out / rebuild). Pushes nothing. */
  reset(): Promise<unknown>;
  /** Interval + focus + online delta polling; returns stop. One active poller per store. */
  startPolling(): () => void;
  /** Stop polling and drop listeners. The observables themselves are GC'd with the store. */
  dispose(): void;
  // Write helpers used by optimistic mutation hooks.
  createNote(input: {
    title?: string;
    titleIntent?: "default";
    folderId?: string | null;
    eventId?: string | null;
    iconUrl?: string | null;
  }): string;
  updateNote(
    id: string,
    patch: Partial<
      Pick<NoteRow, "title" | "folderId" | "eventId" | "iconUrl" | "starred" | "meta">
    >,
  ): void;
  deleteNote(id: string): void;
  createFolder(input: { name: string; parentId?: string | null }): string;
  updateFolder(
    id: string,
    patch: Partial<Pick<FolderRow, "name" | "parentId" | "iconUrl" | "isFavorite" | "meta">>,
  ): void;
  deleteFolder(id: string): void;
  /** Returns null (refused) when the name sanitizes to empty. Reuses a case-colliding live tag. */
  createTag(name: string, color?: string): string | null;
  renameTag(id: string, name: string): void;
  updateTag(id: string, patch: Partial<Pick<TagRow, "color" | "isFavorite">>): void;
  deleteTag(id: string): void;
  findTagByName(name: string): TagRow | undefined;
  addNoteTag(noteId: string, tagId: string): void;
  removeNoteTag(noteId: string, tagId: string): void;
  /**
   * Link a note to one of MY calendar events (optimistic; the server keys it on the event's
   * cross-user key). `event.key` is required to key the local row — events from a server that
   * predates it cannot be linked optimistically.
   */
  linkNoteEvent(input: {
    noteId: string;
    event: { id: string; key: string; title: string; start: string; end: string; joinUrl?: string };
    isPrimary?: boolean;
  }): void;
  /** Re-link as primary (the server upsert demotes the current one). Needs my own row for the event. */
  setPrimaryNoteEvent(noteId: string, eventKey: string): void;
  /** Tombstone a link. `decline` = the undo of an automatic link: never suggest this event again. */
  unlinkNoteEvent(noteId: string, eventKey: string, opts?: { decline?: boolean }): void;
}

export function createSyncStore(options: SyncStoreOptions): SyncStore {
  const { partition } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const list = async <T>(
    route: string,
    lastSync?: number,
    extraQuery?: Record<string, string | number>,
  ): Promise<T[]> =>
    options.getRequestOptions
      ? restList<T>(route, lastSync, extraQuery, await options.getRequestOptions())
      : restList<T>(route, lastSync, extraQuery);
  const create = async <T>(route: string, input: unknown): Promise<T> =>
    options.getRequestOptions
      ? restCreate<T>(route, input, await options.getRequestOptions())
      : restCreate<T>(route, input);
  const update = async <T>(route: string, id: string, input: unknown): Promise<T> =>
    options.getRequestOptions
      ? restUpdate<T>(route, id, input, await options.getRequestOptions())
      : restUpdate<T>(route, id, input);
  const remove = async (route: string, id: string): Promise<void> =>
    options.getRequestOptions
      ? restRemove(route, id, await options.getRequestOptions())
      : restRemove(route, id);
  const listNoteTags = async (lastSync?: number): Promise<NoteTagRow[]> =>
    options.getRequestOptions
      ? restNoteTagList(lastSync, await options.getRequestOptions())
      : restNoteTagList(lastSync);
  const createNoteTag = async (noteId: string, tagId: string): Promise<void> =>
    options.getRequestOptions
      ? restNoteTagCreate(noteId, tagId, await options.getRequestOptions())
      : restNoteTagCreate(noteId, tagId);
  const removeNoteTag = async (noteId: string, tagId: string): Promise<void> =>
    options.getRequestOptions
      ? restNoteTagRemove(noteId, tagId, await options.getRequestOptions())
      : restNoteTagRemove(noteId, tagId);
  const listNoteEvents = async (lastSync?: number): Promise<NoteEventRow[]> =>
    options.getRequestOptions
      ? restNoteEventList(lastSync, await options.getRequestOptions())
      : restNoteEventList(lastSync);
  const createNoteEvent = async (body: {
    noteId: string;
    eventId: string;
    isPrimary?: boolean;
  }): Promise<NoteEventRow> =>
    options.getRequestOptions
      ? restNoteEventCreate(body, await options.getRequestOptions())
      : restNoteEventCreate(body);
  const removeNoteEvent = async (linkId: string, decline: boolean): Promise<void> =>
    options.getRequestOptions
      ? restNoteEventRemove(linkId, decline, await options.getRequestOptions())
      : restNoteEventRemove(linkId, decline);

  const dropped =
    (collection: string, op: "create" | "update" | "delete", extra?: () => void) => () => {
      extra?.();
      options.onWriteRejected?.({ collection, op });
    };

  const persistFor = (table: SyncTableName) =>
    options.persistPlugin
      ? { persist: { plugin: options.persistPlugin, name: table, retrySync: true } }
      : {};

  // ── Gated note create (per-store, NOT module-level: desktop is multi-identity) ──
  const locallyCreatedNotes = new Set<string>();
  const createAckedNotes = new Set<string>();
  const createAckWaiters = new Map<string, (() => void)[]>();

  const resolveNoteCreateAck = (id: string): void => {
    if (!locallyCreatedNotes.has(id) || createAckedNotes.has(id)) return;
    createAckedNotes.add(id);
    const waiters = createAckWaiters.get(id);
    if (waiters) {
      createAckWaiters.delete(id);
      for (const waiter of waiters) waiter();
    }
  };

  const whenNoteCreateAcked = (id: string, timeoutMs = 20_000): Promise<void> => {
    if (!locallyCreatedNotes.has(id) || createAckedNotes.has(id)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const waiters = createAckWaiters.get(id) ?? [];
      waiters.push(finish);
      createAckWaiters.set(id, waiters);
      // Safety valve: a permanently-stuck create must not block the editor forever;
      // an online create acks well under a second, so this never fires in practice.
      setTimeout(() => {
        if (!done) {
          console.warn(`[sync] gated-create: note ${id} not acked in ${timeoutMs}ms — proceeding`);
        }
        finish();
      }, timeoutMs);
    });
  };

  function crud<T extends { id: string; updatedAt: SyncTimestamp }>(
    route: "notes" | "folders" | "tags",
    table: SyncTableName,
    onSavedRow?: (saved: T) => void,
    onDroppedCreate?: (input: T) => void,
  ) {
    return syncedCrud<T>({
      list: async (params: SyncedGetParams<T>) => {
        // Remember only rows acknowledged before this snapshot began. A row
        // created during the request (or still awaiting POST) is not absent from
        // the server merely because the older snapshot does not contain it.
        const before = params.value as unknown as
          | Record<string, T & { createdAt?: SyncTimestamp }>
          | undefined;
        const acknowledgedBefore = Object.values(before ?? {})
          .filter(row => row.createdAt)
          .map(row => row.id);
        const rows = await list<T>(
          route,
          params.lastSync || undefined,
          route === "notes" ? { includeBody: 1 } : undefined
        );
        if (params.lastSync) return rows;

        // Full pulls must still remove older rows that were deleted or became
        // unreadable. Express those absences as tombstones, then assign rows so
        // concurrent optimistic/acknowledged creates and their pending writes
        // survive. Do not echo local rows as GET results: that can cancel create
        // retries or advance the server cursor past unseen changes.
        const returned = new Set(rows.map(row => row.id));
        const absent = acknowledgedBefore
          .filter(id => !returned.has(id))
          .map(id => ({
            id,
            deletedAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
          }));
        params.mode = "assign";
        return [...rows, ...(absent as unknown as T[])];
      },
      create: (input: T, params: SyncedSetParams<T>) =>
        create<T>(route, input).catch(
          terminal4xx(
            route,
            "create",
            params,
            dropped(route, "create", onDroppedCreate ? () => onDroppedCreate(input) : undefined),
          ),
        ),
      update: (input: Partial<T>, params: SyncedSetParams<T>) =>
        update<T>(route, input.id as string, input).catch(
          terminal4xx(route, "update", params, dropped(route, "update")),
        ),
      delete: (input: T, params: SyncedSetParams<T>) =>
        remove(route, input.id).then(
          () => {
            // Deleting a folder also detaches notes and promotes child folders.
            // Pull only after the server has committed those related changes.
            if (route === "folders") {
              void Promise.all([syncState(notes$).sync(), syncState(folders$).sync()])
                .catch(() => undefined);
            }
            return null;
          },
          terminal4xx(route, "delete", params, dropped(route, "delete")),
        ),
      ...persistFor(table),
      changesSince: "last-sync",
      fieldUpdatedAt: "updatedAt",
      fieldCreatedAt: "createdAt",
      fieldDeleted: "deletedAt",
      ...(onSavedRow
        ? { onSaved: ({ saved }: { saved: T }) => void (saved && onSavedRow(saved)) }
        : {}),
      // Send only changed fields on update — a whole-row PUT would clobber
      // concurrently-changed fields under the server's whole-row LWW.
      updatePartial: true,
      retry: { infinite: true },
      as: "object",
    });
  }

  const notes$ = observable(
    crud<NoteRow>(
      "notes",
      "notes",
      (saved) => {
        resolveNoteCreateAck(saved.id);
        // A create that named an event was linked server-side in the same transaction (the
        // transitional `eventId` path); pull the link now rather than on the next poll tick so the
        // editor's meeting chip is there when the note opens. (`noteEvents$` is initialised below;
        // this only ever runs after the create round-trips.)
        if (saved.eventId) void syncState(noteEvents$ as never).sync().catch(() => undefined);
      },
      // A terminally-dropped create also releases the gate: the optimistic row was
      // reverted away; letting the collab lane connect (and lazy-create server-side)
      // beats losing the user's typed body behind the 20s valve on every open.
      (input) => resolveNoteCreateAck(input.id),
    ),
  );
  const folders$ = observable(crud<FolderRow>("folders", "folders"));
  const tags$ = observable(crud<TagRow>("tags", "tags"));

  const noteTags$ = observable(
    syncedCrud<NoteTagRow>({
      list: ({ lastSync }: SyncedGetParams<NoteTagRow>) => listNoteTags(lastSync || undefined),
      create: (input: NoteTagRow, params: SyncedSetParams<NoteTagRow>) =>
        createNoteTag(input.noteId, input.tagId)
          .then((): NoteTagRow | null => input)
          .catch(terminal4xx("note-tags", "create", params, dropped("note-tags", "create"))),
      delete: (input: NoteTagRow, params: SyncedSetParams<NoteTagRow>) =>
        removeNoteTag(input.noteId, input.tagId).then(
          () => null,
          terminal4xx("note-tags", "delete", params, dropped("note-tags", "delete")),
        ),
      // A link's parents (note, tag) are created through SEPARATE queues, so the
      // link POST could reach core before the parent create it references — a 404
      // that is TRANSIENT, which terminal4xx would wrongly drop. Gate each link
      // create until parents minted on this device are server-acked (createdAt
      // backfilled). Rows unknown locally (already server-side, or reverted away)
      // don't block — the reverted case 404s and is dropped+reverted too.
      waitForSet: (p: WaitForSetFnParams<NoteTagRow>) => {
        // syncedCrud spreads {type} into the params at call time; the declared
        // WaitForSetFnParams type doesn't carry it (same gap mobile works around).
        const type = (p as unknown as { type?: string }).type;
        if (type !== "create") return undefined;
        const { noteId, tagId } = p.value;
        return () => {
          const tagRow = tags$[tagId]!.get() as TagRow | undefined;
          const noteRow = notes$[noteId]!.get() as NoteRow | undefined;
          return (!tagRow || !!tagRow.createdAt) && (!noteRow || !!noteRow.createdAt);
        };
      },
      ...persistFor("noteTags"),
      changesSince: "last-sync",
      fieldUpdatedAt: "updatedAt",
      fieldCreatedAt: "createdAt",
      fieldDeleted: "deletedAt",
      retry: { infinite: true },
      as: "object",
    }),
  );

  // Declines are decided at unlink time but only known to the delete callback through the row
  // it receives, so remember them here (the row itself must not change before its delete).
  const pendingDeclines = new Set<string>();

  const noteEvents$ = observable(
    syncedCrud<NoteEventRow>({
      list: ({ lastSync }: SyncedGetParams<NoteEventRow>) => listNoteEvents(lastSync || undefined),
      create: (input: NoteEventRow, params: SyncedSetParams<NoteEventRow>) =>
        input.eventId
          ? createNoteEvent({ noteId: input.noteId, eventId: input.eventId, isPrimary: input.isPrimary })
              .then((saved): NoteEventRow => saved)
              .catch(terminal4xx("noteEvents", "create", params, dropped("noteEvents", "create")))
          : Promise.resolve(input),
      // The only update pushed is "make primary": the server upsert on (note, event) demotes the
      // rest itself, so the local demotion of the previous primary must NOT be pushed — it would
      // read as "make THAT one primary" and undo the promotion.
      update: (input: Partial<NoteEventRow>, params: SyncedSetParams<NoteEventRow>) =>
        input.noteId && input.eventId && input.isPrimary
          ? createNoteEvent({ noteId: input.noteId, eventId: input.eventId, isPrimary: true })
              .then((saved): NoteEventRow => saved)
              .catch(terminal4xx("noteEvents", "update", params, dropped("noteEvents", "update")))
          : Promise.resolve(input as NoteEventRow),
      delete: (input: NoteEventRow, params: SyncedSetParams<NoteEventRow>) => {
        const decline = pendingDeclines.delete(input.id);
        // Never acked: there is no server row to remove (a still-queued create is superseded by
        // the next pull either way).
        if (!input.linkId) return Promise.resolve(null);
        return removeNoteEvent(input.linkId, decline).then(
          () => null,
          terminal4xx("noteEvents", "delete", params, dropped("noteEvents", "delete")),
        );
      },
      // Same parent gating as note-tags: the link POST must not reach core before the note's
      // own create (a transient 404 terminal4xx would wrongly drop).
      waitForSet: (p: WaitForSetFnParams<NoteEventRow>) => {
        const type = (p as unknown as { type?: string }).type;
        if (type !== "create") return undefined;
        const { noteId } = p.value;
        return () => {
          const noteRow = notes$[noteId]!.get() as NoteRow | undefined;
          return !noteRow || !!noteRow.createdAt;
        };
      },
      ...persistFor("noteEvents"),
      changesSince: "last-sync",
      fieldUpdatedAt: "updatedAt",
      fieldCreatedAt: "createdAt",
      fieldDeleted: "deletedAt",
      retry: { infinite: true },
      as: "object",
    }),
  );

  const collections = [notes$, folders$, tags$, noteTags$, noteEvents$] as const;

  const refreshAll = (): Promise<unknown> =>
    Promise.all(collections.map((collection$) => syncState(collection$ as never).sync()));

  const reset = (): Promise<unknown> =>
    Promise.all(collections.map((collection$) => syncState(collection$ as never).reset()));

  // ── Poller (desktop cadence; Legend itself syncs on activation only) ──
  let stopPolling: (() => void) | null = null;
  const startPolling = (): (() => void) => {
    stopPolling?.();
    const tick = () => void refreshAll().catch(() => undefined);
    const interval = pollIntervalMs > 0 ? setInterval(tick, pollIntervalMs) : null;
    const hasWindow = typeof window !== "undefined";
    const onFocus = () => tick();
    if (hasWindow) {
      window.addEventListener("focus", onFocus);
      window.addEventListener("online", onFocus);
    }
    const stop = () => {
      if (interval) clearInterval(interval);
      if (hasWindow) {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("online", onFocus);
      }
      if (stopPolling === stop) stopPolling = null;
    };
    stopPolling = stop;
    return stop;
  };

  return {
    partition,
    notes$,
    folders$,
    tags$,
    noteTags$,
    noteEvents$,
    whenNoteCreateAcked,
    refreshAll,
    reset,
    startPolling,
    dispose: () => stopPolling?.(),

    createNote: (input) => {
      const id = createId("note");
      locallyCreatedNotes.add(id);
      // Deliberately NO createdAt (create → POST; core's PUT 404s unknown ids) and
      // synthesized derived fields (the raw write echo won't carry them; the next
      // pull re-delivers the joined wire row). `title` is omitted for event-linked
      // creates so the server resolves the event's title (its create-default); the
      // echo merges it back onto this row.
      notes$[id]!.set({
        id,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.titleIntent ? { titleIntent: input.titleIntent } : {}),
        titleSource:
          input.titleIntent === "default" || !input.title
            ? input.eventId
              ? "calendar"
              : "placeholder"
            : "manual",
        titleRevision: 0,
        folderId: input.folderId ?? null,
        // Only when the caller said so: an explicit null means "no event", an ABSENT field lets the
        // server associate a note created during one of the user's meetings (undoable) - so a
        // plain "New note" must not send null.
        ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
        iconUrl: input.iconUrl ?? null,
        starred: false,
        excerpt: null,
        folderName: null,
        isOwner: true,
        canWrite: true,
        sharedByName: null,
        updatedAt: nowIso(),
      });
      return id;
    },
    updateNote: (id, patch) => {
      notes$[id]!.assign({
        ...patch,
        ...(patch.title !== undefined
          ? {
              titleSource: patch.title?.trim() ? "manual" : "placeholder",
              // Protect a local title edit (including reset) before its server echo arrives.
              // The server ignores this optimistic revision and assigns its own under lock.
              titleRevision: (notes$[id]!.peek()?.titleRevision ?? 0) + 1,
            }
          : {}),
        updatedAt: nowIso(),
      });
    },
    deleteNote: (id) => {
      notes$[id]!.delete();
    },

    createFolder: (input) => {
      const id = createId("folder");
      folders$[id]!.set({
        id,
        name: input.name,
        parentId: input.parentId ?? null,
        updatedAt: nowIso(),
      });
      return id;
    },
    updateFolder: (id, patch) => {
      folders$[id]!.assign({ ...patch, updatedAt: nowIso() });
    },
    deleteFolder: (id) => {
      folders$[id]!.delete();
    },

    createTag: (name, color = "green") => {
      const clean = sanitizeTagNameInput(name);
      if (!clean) {
        // The server would normalize this to the literal 'tag' — refusing loudly
        // beats stranding a mystery tag; the client is stricter than the server fallback.
        console.error(
          `[sync] createTag: name ${JSON.stringify(name)} sanitizes to empty — refused`,
        );
        return null;
      }
      const id = createId("tag");
      tags$[id]!.set({ id, name: clean, color, isFavorite: false, updatedAt: nowIso() });
      return id;
    },
    renameTag: (id, name) => {
      const clean = sanitizeTagNameInput(name);
      if (!clean) {
        console.error(`[sync] renameTag(${id}): name sanitizes to empty — ignored`);
        return;
      }
      tags$[id]!.assign({ name: clean, updatedAt: nowIso() });
    },
    updateTag: (id, patch) => {
      tags$[id]!.assign({ ...patch, updatedAt: nowIso() });
    },
    deleteTag: (id) => {
      tags$[id]!.delete();
    },
    findTagByName: (name) => {
      // Normalize new input, but preserve distinct legacy names when comparing stored rows.
      const target = sanitizeTagNameInput(name).toLowerCase();
      if (!target) return undefined;
      const rows = tags$.peek() as Record<string, TagRow> | undefined;
      return Object.values(rows ?? {}).find(
        (row) => row && !row.deletedAt && row.name.toLowerCase() === target,
      );
    },

    addNoteTag: (noteId, tagId) => {
      const id = `${noteId}:${tagId}`;
      const ts = nowIso();
      // No createdAt (create → POST; the link POST is an upsert keyed on the pair).
      noteTags$[id]!.set({ id, noteId, tagId, addedAt: ts, updatedAt: ts });
    },
    removeNoteTag: (noteId, tagId) => {
      const id = `${noteId}:${tagId}`;
      const existing = noteTags$[id]!.peek() as NoteTagRow | undefined;
      if (existing && !existing.deletedAt) noteTags$[id]!.delete();
    },

    linkNoteEvent: ({ noteId, event, isPrimary }) => {
      const id = `${noteId}:${event.key}`;
      const rows = noteEvents$.peek() as Record<string, NoteEventRow> | undefined;
      const hasPrimary = Object.values(rows ?? {}).some(
        (r) => r && r.noteId === noteId && r.isPrimary && !r.deletedAt && r.id !== id,
      );
      // No createdAt (create → POST; the link POST is an upsert keyed on the pair).
      noteEvents$[id]!.set({
        id,
        noteId,
        eventKey: event.key,
        eventId: event.id,
        isPrimary: isPrimary ?? !hasPrimary,
        source: "user",
        title: event.title,
        startsAt: event.start,
        endsAt: event.end,
        meetingUrl: event.joinUrl ?? null,
        updatedAt: nowIso(),
      });
    },
    setPrimaryNoteEvent: (noteId, eventKey) => {
      const id = `${noteId}:${eventKey}`;
      const target = noteEvents$[id]!.peek() as NoteEventRow | undefined;
      if (!target || target.deletedAt || !target.eventId || target.isPrimary) return;
      const rows = noteEvents$.peek() as Record<string, NoteEventRow> | undefined;
      for (const r of Object.values(rows ?? {})) {
        if (r && r.noteId === noteId && r.isPrimary && !r.deletedAt && r.id !== id) {
          // Local demotion only — the server does it as part of the promote upsert.
          noteEvents$[r.id]!.assign({ isPrimary: false });
        }
      }
      noteEvents$[id]!.assign({ isPrimary: true, updatedAt: nowIso() });
    },
    unlinkNoteEvent: (noteId, eventKey, opts) => {
      const id = `${noteId}:${eventKey}`;
      const existing = noteEvents$[id]!.peek() as NoteEventRow | undefined;
      if (!existing || existing.deletedAt) return;
      if (opts?.decline) pendingDeclines.add(id);
      noteEvents$[id]!.delete();
    },
  };
}

/** Desktop persistence plugin for a partition (renderer IndexedDB). Web passes none today. */
export async function createIndexedDbPersistPlugin(
  partition: SyncPartition,
): Promise<ObservablePersistPlugin> {
  const { observablePersistIndexedDB } = await import("@legendapp/state/persist-plugins/indexeddb");
  const { SYNC_TABLE_NAMES, SYNC_DB_VERSION } = await import("./partition");
  return observablePersistIndexedDB({
    databaseName: partitionDatabaseName(partition),
    version: SYNC_DB_VERSION,
    tableNames: [...SYNC_TABLE_NAMES],
  });
}
