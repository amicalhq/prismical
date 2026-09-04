"use client";

/**
 * Note↔tag link hooks — Legend-State-native hooks over the sync
 * store's composite-key junction collection. Link creates gate on their
 * parents' server ack inside the store (waitForSet); removing an
 * already-removed link acks via the store's 404-as-ack handling.
 */
import { syncState } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import { useSyncStore } from "../../sync/provider";
import type { NoteTagRow } from "../../sync/store";
import { listResult, type SyncListResult, type SyncMutationResult } from "./notes";
import type { CoreNoteTag } from "../adapters";

/** All note↔tag links for the current identity; callers group by noteId. */
export function useAllNoteTags(): SyncListResult<CoreNoteTag[]> {
  const store = useSyncStore();
  return useSelector(() => {
    if (!store) {
      return { data: undefined, isLoading: true, isSuccess: false, error: undefined, refetch: () => {} };
    }
    const state = syncState(store.noteTags$);
    return listResult(
      store,
      store.noteTags$.get() as Record<string, NoteTagRow> | undefined,
      { isLoaded: state.isLoaded.get(), error: state.error.get() },
      (row) => ({ noteId: row.noteId, tagId: row.tagId }),
    );
  });
}

export function useAddNoteTag(noteId: string): SyncMutationResult<string, void> {
  const store = useSyncStore();
  return {
    mutate: (tagId, callbacks) => {
      store?.addNoteTag(noteId, tagId);
      callbacks?.onSuccess?.();
    },
    mutateAsync: async (tagId) => void store?.addNoteTag(noteId, tagId),
    isPending: false,
  };
}

export function useRemoveNoteTag(noteId: string): SyncMutationResult<string, void> {
  const store = useSyncStore();
  return {
    mutate: (tagId, callbacks) => {
      store?.removeNoteTag(noteId, tagId);
      callbacks?.onSuccess?.();
    },
    mutateAsync: async (tagId) => void store?.removeNoteTag(noteId, tagId),
    isPending: false,
  };
}
