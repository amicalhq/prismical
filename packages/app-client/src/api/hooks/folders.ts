"use client";

/**
 * Folder data hooks — Legend-State-native hooks over the sync
 * store (see notes.ts for the shape/optimism conventions). Reads select from
 * the partition's `folders$`; writes are optimistic store mutations pushed by
 * syncedCrud. Rejections revert + toast via the provider lane.
 */
import { syncState } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import { toFolder, type CoreFolder } from "../adapters";
import { useSyncStore } from "../../sync/provider";
import type { FolderRow } from "../../sync/store";
import { listResult, type SyncListResult, type SyncMutationResult } from "./notes";
import type { Folder } from "@prismical/app-contracts";

function folderFromRow(row: FolderRow): Folder {
  // createdAt is absent on an optimistic row until the echo backfills it —
  // fall back to updatedAt so the contract type stays satisfied.
  return toFolder({
    ...row,
    createdAt: String(row.createdAt ?? row.updatedAt),
  } as CoreFolder);
}

export function useFolders(): SyncListResult<Folder[]> {
  const store = useSyncStore();
  return useSelector(() => {
    if (!store) {
      return { data: undefined, isLoading: true, isSuccess: false, error: undefined, refetch: () => {} };
    }
    const state = syncState(store.folders$);
    return listResult(
      store,
      store.folders$.get() as Record<string, FolderRow> | undefined,
      { isLoaded: state.isLoaded.get(), error: state.error.get() },
      folderFromRow,
    );
  });
}

/** A bare name creates at the top level; pass `parentId` to nest it under a folder. */
export type CreateFolderInput = string | { name: string; parentId?: string | null };

/**
 * Create a folder — client-minted `fld_` id, optimistic row, result immediately (the caller shows
 * it without any round-trip). Depth is not checked here: the limit the folders screen puts on
 * creating is about how deep a tree stays legible, not about what the store can hold, and a tree
 * built through the API or on another client can be deeper than that.
 */
export function useCreateFolder(): SyncMutationResult<CreateFolderInput, Folder> {
  const store = useSyncStore();
  const create = (input: CreateFolderInput): Folder => {
    if (!store) throw new Error("sync store not ready");
    const name = typeof input === "string" ? input : input.name;
    const parentId = typeof input === "string" ? null : (input.parentId ?? null);
    const id = store.createFolder({ name, parentId });
    return folderFromRow(store.folders$[id]!.peek() as FolderRow);
  };
  return {
    mutate: (input, callbacks) => {
      const folder = create(input);
      callbacks?.onSuccess?.(folder);
    },
    mutateAsync: async (input) => create(input),
    isPending: false,
  };
}

/** What a folder edit can change. `parentId` moves it; null puts it back at the top level. */
export type UpdateFolderPatch = { name?: string; isFavorite?: boolean; parentId?: string | null };

/**
 * Update a folder — rename, favorite toggle, or move. Only the keys present in
 * `patch` are written (updatePartial keeps the wire partial too).
 *
 * A move is not validated here: whether a target is legal (not the folder's own descendant, and
 * within the depth the UI allows) depends on the whole tree, which the screen offering the move
 * already has in hand.
 */
export function useUpdateFolder(): SyncMutationResult<
  { id: string; patch: UpdateFolderPatch },
  Folder | undefined
> {
  const store = useSyncStore();
  const update = ({ id, patch }: { id: string; patch: UpdateFolderPatch }) => {
    store?.updateFolder(id, patch);
    const row = store?.folders$[id]!.peek() as FolderRow | undefined;
    return row ? folderFromRow(row) : undefined;
  };
  return {
    mutate: (vars, callbacks) => {
      const folder = update(vars);
      callbacks?.onSuccess?.(folder);
    },
    mutateAsync: async (vars) => update(vars),
    isPending: false,
  };
}

/**
 * Delete (soft-tombstone) a folder. Notes inside are NOT deleted — the server
 * nulls their folderId; the next delta pull re-delivers them un-foldered.
 */
export function useDeleteFolder(): SyncMutationResult<string, void> {
  const store = useSyncStore();
  return {
    mutate: (id, callbacks) => {
      store?.deleteFolder(id);
      callbacks?.onSuccess?.();
    },
    mutateAsync: async (id) => void store?.deleteFolder(id),
    isPending: false,
  };
}

// Local tree helpers (unchanged).
export function rootFolders(all: Folder[]): Folder[] {
  return all.filter((f) => f.parentId === null);
}
export function childFolders(all: Folder[], parentId: string): Folder[] {
  return all.filter((f) => f.parentId === parentId);
}
export function folderById(all: Folder[], id?: string): Folder | undefined {
  return id ? all.find((f) => f.id === id) : undefined;
}
export function folderSubtreeIds(all: Folder[], id: string): string[] {
  const out = [id];
  for (const child of childFolders(all, id)) out.push(...folderSubtreeIds(all, child.id));
  return out;
}
