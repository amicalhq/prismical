"use client";

/**
 * Tag data hooks — Legend-State-native hooks over the sync store
 * (see notes.ts for the shape/optimism conventions). Names are sanitized in
 * the store before the wire (client sanitize ≡ server normalize, contract-
 * pinned), and a name colliding case-insensitively with a live tag is reused
 * via findTagByName by callers where applicable; a server 409 reverts + toasts.
 */
import { syncState } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import { toTag, type CoreTag } from "../adapters";
import { nextAutoColor } from "../../tags/tag-colors";
import { useSyncStore } from "../../sync/provider";
import type { TagRow } from "../../sync/store";
import { listResult, type SyncListResult, type SyncMutationResult } from "./notes";
import type { Tag } from "@prismical/app-contracts";

function tagFromRow(row: TagRow): Tag {
  return toTag({ ...row, createdAt: String(row.createdAt ?? row.updatedAt) } as CoreTag);
}

export function useTags(): SyncListResult<Tag[]> {
  const store = useSyncStore();
  return useSelector(() => {
    if (!store) {
      return { data: undefined, isLoading: true, isSuccess: false, error: undefined, refetch: () => {} };
    }
    const state = syncState(store.tags$);
    return listResult(
      store,
      store.tags$.get() as Record<string, TagRow> | undefined,
      { isLoaded: state.isLoaded.get(), error: state.error.get() },
      tagFromRow,
    );
  });
}

/**
 * Create a tag — client-minted `tag_` id, color auto-assigned from the
 * least-used preset among the tags currently in the store (as before). If the
 * name collides case-insensitively with a live tag, that tag is REUSED instead
 * of creating into a guaranteed 409.
 */
export function useCreateTag(): SyncMutationResult<string, Tag> {
  const store = useSyncStore();
  const create = (name: string): Tag => {
    if (!store) throw new Error("sync store not ready");
    const existing = store.findTagByName(name);
    if (existing) return tagFromRow(existing);
    const rows = Object.values((store.tags$.peek() ?? {}) as Record<string, TagRow>);
    const color = nextAutoColor(rows.map((t) => t.color));
    const id = store.createTag(name, color);
    if (!id) throw new Error("tag name is empty after sanitization");
    return tagFromRow(store.tags$[id]!.peek() as TagRow);
  };
  return {
    mutate: (name, callbacks) => {
      const tag = create(name);
      callbacks?.onSuccess?.(tag);
    },
    mutateAsync: async (name) => create(name),
    isPending: false,
  };
}

/**
 * Update a tag — rename, recolor, or favorite toggle; only the keys present in
 * `patch` are written (a pure recolor never re-sends the name — same rule as
 * before, so legacy names can't get re-normalized by an unrelated edit).
 */
export function useUpdateTag(): SyncMutationResult<
  { id: string; patch: { name?: string; color?: string; isFavorite?: boolean } },
  Tag | undefined
> {
  const store = useSyncStore();
  const update = ({
    id,
    patch,
  }: {
    id: string;
    patch: { name?: string; color?: string; isFavorite?: boolean };
  }): Tag | undefined => {
    if (!store) return undefined;
    const { name, ...rest } = patch;
    if (name !== undefined) store.renameTag(id, name);
    if (Object.keys(rest).length) store.updateTag(id, rest);
    const row = store.tags$[id]!.peek() as TagRow | undefined;
    return row ? tagFromRow(row) : undefined;
  };
  return {
    mutate: (vars, callbacks) => {
      const tag = update(vars);
      callbacks?.onSuccess?.(tag);
    },
    mutateAsync: async (vars) => update(vars),
    isPending: false,
  };
}

/**
 * Delete (soft-tombstone) a tag. Its links resolve to nothing once the tag
 * leaves the list, so chips disappear from every note (as before).
 */
export function useDeleteTag(): SyncMutationResult<string, void> {
  const store = useSyncStore();
  return {
    mutate: (id, callbacks) => {
      store?.deleteTag(id);
      callbacks?.onSuccess?.();
    },
    mutateAsync: async (id) => void store?.deleteTag(id),
    isPending: false,
  };
}
