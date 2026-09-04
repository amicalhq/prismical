/**
 * Sync wire layer — the REST calls used by the Legend-State `syncedCrud`
 * collections. Important contracts:
 *
 *  - Rides `apiClient`, so the platform transport decides the lane:
 *    TransportPort IPC on desktop (auth stamped in main — this layer never
 *    sees tokens), plain fetch on web. Paths are `ME_PREFIX`-versioned only
 *    (`/apps/v1/me/*`; the bare alias is being sunset).
 *  - Delta pulls send `since` (ISO) + `includeDeleted=1` ONLY when a cursor
 *    exists: a first pull into an empty store has nothing to
 *    tombstone, so skip the historical-tombstone payload).
 *  - Writes surface the full sync envelope so an `applied:false` (a stale
 *    write the server rejected under LWW) is at least observable — the echoed
 *    row is the SERVER-WINNING row either way, which is exactly what the
 *    caller must merge back (never local intent).
 *  - note-tags is a composite-key junction (no `id` column, timestamp-less
 *    write echoes): the wire rows get `id = noteId:tagId` synthesized here so
 *    Legend can key them.
 *
 * Dialect contract: pinned by the server's sync client-contract suite (real
 * engine) and the desktop fake-sync contract suite (fake server). Change
 * those suites and this layer together.
 */
import {
  NoteTagResponseSchema,
  SyncDeleteResponseSchema,
  SyncListResponseSchema,
  SyncWriteResponseSchema,
  type SyncWriteEnvelope,
} from "@prismical/api-contracts/apps/v1";
import { ME_PREFIX, apiClient } from "../api/client";

export type { SyncWriteEnvelope } from "@prismical/api-contracts/apps/v1";

export interface SyncRequestOptions {
  authToken: string;
  activeOrgId: string | null;
}

const base = (route: string): string => `${ME_PREFIX}/${route}`;

function logIfNotApplied(route: string, op: string, envelope: SyncWriteEnvelope<unknown>): void {
  if (envelope.applied === false) {
    // A stale write lost LWW server-side. The server-winning row is merged back
    // by the caller; log so silent losses are observable.
    console.warn(`[sync] ${route} ${op}: write not applied (stale LWW) — server row kept`);
  }
}

/**
 * Delta list. `lastSyncMs` is Legend's cursor (epoch-ms); absent ⇒ first full
 * pull. `extraQuery` carries per-lane params (notes: `includeBody=1` — bodies
 * resident so copy-as-markdown and Ask-context can consume them).
 */
export async function restList<T>(
  route: string,
  lastSyncMs?: number,
  extraQuery?: Record<string, string | number>,
  opts?: SyncRequestOptions,
): Promise<T[]> {
  const delta =
    lastSyncMs !== undefined
      ? { since: new Date(lastSyncMs).toISOString(), includeDeleted: 1 }
      : undefined;
  const response = await apiClient.getRaw<unknown>(
    base(route),
    delta || extraQuery ? { ...extraQuery, ...delta } : undefined,
    opts,
  );
  return SyncListResponseSchema.parse(response).results as T[];
}

/** LWW create (POST — optimistic rows carry no `createdAt`, so creates route here). */
export async function restCreate<T>(
  route: string,
  body: unknown,
  opts?: SyncRequestOptions,
): Promise<T> {
  const envelope = SyncWriteResponseSchema.parse(
    await apiClient.postRaw<unknown>(base(route), body, opts),
  ) as SyncWriteEnvelope<T>;
  logIfNotApplied(route, "create", envelope);
  return envelope.result;
}

/** LWW partial update (PUT /:id — 404s an unknown id; never creates). */
export async function restUpdate<T>(
  route: string,
  id: string,
  body: unknown,
  opts?: SyncRequestOptions,
): Promise<T> {
  const envelope = SyncWriteResponseSchema.parse(
    await apiClient.putRaw<unknown>(
      `${base(route)}/${encodeURIComponent(id)}`,
      body,
      opts,
    ),
  ) as SyncWriteEnvelope<T>;
  logIfNotApplied(route, "update", envelope);
  return envelope.result;
}

/** Tombstone delete ({success:true}; 404 = already gone, the caller's ack case). */
export async function restRemove(
  route: string,
  id: string,
  opts?: SyncRequestOptions,
): Promise<void> {
  SyncDeleteResponseSchema.parse(
    await apiClient.delRaw<unknown>(`${base(route)}/${encodeURIComponent(id)}`, opts),
  );
}

// ── note-tags junction (composite key noteId:tagId — no id column on the wire) ──

export interface NoteTagWire {
  noteId: string;
  tagId: string;
  addedAt?: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** Delta list of links, with the composite `id` Legend keys on synthesized. */
export async function restNoteTagList(
  lastSyncMs?: number,
  opts?: SyncRequestOptions,
): Promise<(NoteTagWire & { id: string })[]> {
  const rows = await restList<NoteTagWire>("note-tags", lastSyncMs, undefined, opts);
  return rows.map((row) => ({ ...row, id: `${row.noteId}:${row.tagId}` }));
}

/** Link create — echo carries ONLY {noteId, tagId}; the caller synthesizes its local row. */
export async function restNoteTagCreate(
  noteId: string,
  tagId: string,
  opts?: SyncRequestOptions,
): Promise<void> {
  NoteTagResponseSchema.parse(
    await apiClient.postRaw<unknown>(base("note-tags"), { noteId, tagId }, opts),
  );
}

/** Unlink — {success:true}; 404 = already unlinked (ack). */
export async function restNoteTagRemove(
  noteId: string,
  tagId: string,
  opts?: SyncRequestOptions,
): Promise<void> {
  SyncDeleteResponseSchema.parse(
    await apiClient.delRaw<unknown>(
      `${base("note-tags")}/${encodeURIComponent(noteId)}/${encodeURIComponent(tagId)}`,
      opts,
    ),
  );
}
