"use client";

/**
 * Notes data hooks — Legend-State-native hooks over the sync
 * store: reads are selectors on the active partition's `notes$` collection
 * (instant on a warm partition, offline-capable), writes are OPTIMISTIC store
 * mutations that syncedCrud pushes (and queues offline). The react-query
 * implementation this replaces is deleted — rollback is source control.
 *
 * Hook shapes stay consumer-compatible: reads expose {data, isLoading, error,
 * refetch}; mutations expose {mutate(vars, {onSuccess}), mutateAsync,
 * isPending}. With optimism, onSuccess fires immediately with the local
 * result and isPending is constantly false (there is no in-flight phase to
 * spin on); terminal server rejections revert the row and surface through the
 * provider's toast lane (same messages as the old mutation meta).
 */
import { syncState } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import { useTranslation } from "react-i18next";
import { useApplicationLocale } from "@prismical/app-i18n";
import { toNote, noteUpdateBody, type CoreNote, type NotePatch } from "../adapters";
import { useSyncStore } from "../../sync/provider";
import type { NoteEventRow, NoteRow, SyncStore } from "../../sync/store";
import { useAllNoteTags } from "./note-tags";
import { primaryEventIdByNote } from "./note-events";
import { EVENTS } from "../../analytics-events";
import { usePorts } from "../../ports-context";
import type { Note } from "@prismical/app-contracts";
import {
  markPendingAutoTranscribe,
} from "../../recording/recording-preferences";
import { currentAccountExperience } from "../../settings/account-experience-store";
import { formatDefaultNoteTitle } from "../../notes/default-note-title";

/** Read-result shape shared by the synchronized Legend-State hooks ({data,isLoading,error,refetch}). */
export interface SyncListResult<T> {
  data: T | undefined;
  isLoading: boolean;
  /** True once data is available (persisted, optimistic, or pulled). */
  isSuccess: boolean;
  error: unknown;
  refetch: () => void;
}

/** Optimistic-mutation shape covering how app-ui consumes the old useMutation results. */
export interface SyncMutationResult<TVars, TResult> {
  mutate: (vars: TVars, callbacks?: { onSuccess?: (result: TResult) => void }) => void;
  mutateAsync: (vars: TVars) => Promise<TResult>;
  /**
   * Optimistic writes have no in-flight phase, so this is false for all but one case: a CREATE is
   * pending while the sync store has yet to hydrate locally, because the
   * write helper throws without a store. Callers disable their trigger on it. Spinners otherwise
   * never show.
   */
  isPending: boolean;
}

const asMs = (value: string | Date): number => new Date(value).getTime();

/** The server list order ((updatedAt, id) ascending) — consumers re-sort for display. */
export function sortRows<T extends { id: string; updatedAt: string | Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = asMs(a.updatedAt);
    const tb = asMs(b.updatedAt);
    return ta === tb ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : ta - tb;
  });
}

/** Fold a collection's rows + sync state into the read-result contract. */
export function listResult<TRow extends { id: string; updatedAt: string | Date }, T>(
  store: SyncStore | null,
  rows: Record<string, TRow> | undefined,
  state: { isLoaded: boolean; error?: Error } | null,
  map: (row: TRow) => T,
): SyncListResult<T[]> {
  if (!store || !state) {
    return {
      data: undefined,
      isLoading: true,
      isSuccess: false,
      error: undefined,
      refetch: () => {},
    };
  }
  // Reverting an optimistic create can leave an undefined value in the collection.
  const all = Object.values(rows ?? {}).filter((row): row is TRow => row != null);
  // The provider publishes only after every local collection has hydrated.
  // An empty local collection is usable too; a pending GET is background work.
  const data = sortRows(all).map(map);
  return {
    data,
    isLoading: false,
    isSuccess: true,
    error: undefined,
    refetch: () => void store.refreshAll(),
  };
}

function noteFromRow(row: NoteRow, primaryEvents?: Map<string, string | null>): Note {
  // NoteRow is the CoreNote wire shape (+ resident contentText); timestamps may
  // be Date post-echo (SyncTimestamp) — normalize for the contract type.
  const note = toNote({
    ...row,
    createdAt: row.createdAt == null ? undefined : String(row.createdAt),
    updatedAt: String(row.updatedAt),
  } as CoreNote);
  // `eventId` is MY event row for the note's primary link. The row's own column is the LINKER's
  // row (transitional dual-write): right for the creator's first paint before the link row
  // arrives, meaningless to a collaborator — so the link wins whenever one exists.
  if (primaryEvents?.has(row.id)) note.eventId = primaryEvents.get(row.id) ?? undefined;
  return note;
}

// The notes list with bodies; includeBody rides the sync pull.
// One source powers both the list views and single-note lookups, as before.
export function useNotes(): SyncListResult<Note[]> {
  const store = useSyncStore();
  return useSelector(() => {
    if (!store) {
      return {
        data: undefined,
        isLoading: true,
        isSuccess: false,
        error: undefined,
        refetch: () => {},
      };
    }
    const state = syncState(store.notes$);
    const primaryEvents = primaryEventIdByNote(
      store.noteEvents$.get() as Record<string, NoteEventRow> | undefined,
    );
    return listResult(
      store,
      store.notes$.get() as Record<string, NoteRow> | undefined,
      { isLoaded: state.isLoaded.get(), error: state.error.get() },
      (row) => noteFromRow(row, primaryEvents),
    );
  });
}

// A single note, derived from the notes collection + its tag links (no detail
// endpoint — same derivation as before).
export function useNote(id: string) {
  const store = useSyncStore();
  const notes = useNotes();
  const noteTags = useAllNoteTags();
  const base = notes.data?.find((n) => n.id === id);
  const pendingRemoteLookup = useSelector(() => {
    if (base || !store) return false;
    const state = syncState(store.notes$);
    return !state.isLoaded.get() && !state.error.get();
  });
  const data: Note | undefined = base
    ? { ...base, tagIds: (noteTags.data ?? []).filter((t) => t.noteId === id).map((t) => t.tagId) }
    : undefined;
  return {
    data,
    isLoading: notes.isLoading || noteTags.isLoading || pendingRemoteLookup,
    error: notes.error ?? noteTags.error,
  };
}

/**
 * Create a note — client-minted `nt_…` id (the create's idempotency key), an
 * optimistic row, and an immediate result so navigation to /notes/:id resolves
 * instantly against the store. New notes show a localized placeholder until a calendar
 * name or first body line is available. titleIntent distinguishes that optimistic
 * default from an explicit user title. Collaboration waits for the create acknowledgement.
 */
export function useCreateNote(): SyncMutationResult<
  { folderId?: string; eventId?: string } | undefined,
  Note
> {
  const store = useSyncStore();
  const { analytics, recording } = usePorts();
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const create = (vars?: { folderId?: string; eventId?: string }): Note => {
    if (!store) throw new Error("sync store not ready");
    const title = vars?.eventId ? undefined : formatDefaultNoteTitle(new Date(), resolvedLocale, t);
    const id = store.createNote({
      title,
      titleIntent: "default",
      folderId: vars?.folderId ?? null,
      // Absent (not null) when no event was named: the server may then link a note created
      // during a meeting automatically - see store.createNote.
      eventId: vars?.eventId,
    });
    analytics.capture(EVENTS.NOTE_CREATED, {
      note_id: id,
      from_folder: !!vars?.folderId,
      from_event: !!vars?.eventId,
    });
    if (!recording.control && currentAccountExperience()?.getSnapshot().data?.experience.autoTranscribeNewNotes) {
      markPendingAutoTranscribe(id);
    }
    const row = store.notes$[id]!.peek() as NoteRow;
    return noteFromRow(row);
  };
  return {
    // NOTE: never `callbacks?.onSuccess?.(create(...))` — with no callbacks the
    // optional call short-circuits WITHOUT evaluating its argument.
    mutate: (vars, callbacks) => {
      const note = create(vars);
      callbacks?.onSuccess?.(note);
    },
    mutateAsync: async (vars) => create(vars),
    // Creation waits for local hydration, independently of the first server pull.
    isPending: !store,
  };
}

export function useUpdateNote(id: string): SyncMutationResult<NotePatch, void> {
  const store = useSyncStore();
  const update = (patch: NotePatch): void => {
    // noteUpdateBody maps the UI patch onto wire fields (emoji→iconUrl,
    // folderId ?? null) — the same partial-set semantics the server applies.
    store?.updateNote(id, noteUpdateBody(patch));
  };
  return {
    mutate: (patch, callbacks) => {
      update(patch);
      callbacks?.onSuccess?.();
    },
    mutateAsync: async (patch) => update(patch),
    isPending: false,
  };
}

export function useDeleteNote(): SyncMutationResult<string, void> {
  const store = useSyncStore();
  const { analytics } = usePorts();
  const remove = (id: string): void => {
    if (!store) return;
    store.deleteNote(id);
    analytics.capture(EVENTS.NOTE_DELETED, { note_id: id });
  };
  return {
    mutate: (id, callbacks) => {
      remove(id);
      callbacks?.onSuccess?.();
    },
    mutateAsync: async (id) => remove(id),
    isPending: false,
  };
}

/** Settle a provisional title through the same durable queue as manual renames. */
export function useFreezeNoteTitle(id: string) {
  const store = useSyncStore();
  return (title: string) => {
    const row = store?.notes$[id]?.peek();
    if (!row || row.canWrite === false || !title.trim()) return;
    if (row.titleSource !== 'placeholder' && row.titleSource !== 'first-line') return;
    store!.updateNote(id, {
      title: title.trim(),
      titleIntent: 'freeze',
      titleExpectedRevision: row.titleRevision ?? 0,
    });
  };
}
