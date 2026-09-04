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

/**
 * Create a top-level folder — client-minted `fld_` id, optimistic row, result
 * immediately (the sidebar shows it without any round-trip). Nesting stays
 * unexposed in the sidebar, so `parentId` is always null here (as before).
 */
export function useCreateFolder(): SyncMutationResult<string, Folder> {
  const store = useSyncStore();
  const create = (name: string): Folder => {
    if (!store) throw new Error("sync store not ready");
    const id = store.createFolder({ name, parentId: null });
    return folderFromRow(store.folders$[id]!.peek() as FolderRow);
  };
  return {
    mutate: (name, callbacks) => {
      const folder = create(name);
      callbacks?.onSuccess?.(folder);
    },
    mutateAsync: async (name) => create(name),
    isPending: false,
  };
}

/**
 * Update a folder — rename or favorite toggle. Only the keys present in
 * `patch` are written (updatePartial keeps the wire partial too).
 */
export function useUpdateFolder(): SyncMutationResult<
  { id: string; patch: { name?: string; isFavorite?: boolean } },
  Folder | undefined
> {
  const store = useSyncStore();
  const update = ({ id, patch }: { id: string; patch: { name?: string; isFavorite?: boolean } }) => {
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
