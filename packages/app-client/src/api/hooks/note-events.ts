"use client";

/**
 * Note↔calendar-event link hooks — Legend-State-native hooks over the sync store's `noteEvents$`
 * collection. A note may be linked to several events (one primary). Every link resolves to the
 * CURRENT user's own event row (`eventId`), or renders from the invite snapshot when they hold
 * none (a collaborator's link). Writes are optimistic; the server keys links on the event's
 * cross-user key, so a link made on one device shows up for every attendee with a copy.
 */
import { syncState } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import type { CalendarEvent, NoteEventLink } from "@prismical/app-contracts";
import { useSyncStore } from "../../sync/provider";
import type { NoteEventRow } from "../../sync/store";
import { listResult, type SyncListResult, type SyncMutationResult } from "./notes";

function toLink(row: NoteEventRow): NoteEventLink {
  return {
    noteId: row.noteId,
    eventKey: row.eventKey,
    eventId: row.eventId ?? undefined,
    isPrimary: row.isPrimary,
    source: row.source,
    title: row.title,
    start: row.startsAt ?? undefined,
    end: row.endsAt ?? undefined,
    joinUrl: row.meetingUrl ?? undefined,
  };
}

/** noteId → my event row for the note's primary link (null when I hold none) — for every linked note. */
export function primaryEventIdByNote(
  rows: Record<string, NoteEventRow> | undefined,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const row of Object.values(rows ?? {})) {
    if (row && row.isPrimary && !row.deletedAt) out.set(row.noteId, row.eventId ?? null);
  }
  return out;
}

/** Every live link for the current identity; callers group by noteId. */
export function useAllNoteEvents(): SyncListResult<NoteEventLink[]> {
  const store = useSyncStore();
  return useSelector(() => {
    if (!store) {
      return { data: undefined, isLoading: true, isSuccess: false, error: undefined, refetch: () => {} };
    }
    const state = syncState(store.noteEvents$);
    return listResult(
      store,
      store.noteEvents$.get() as Record<string, NoteEventRow> | undefined,
      { isLoaded: state.isLoaded.get(), error: state.error.get() },
      toLink,
    );
  });
}

/** One note's links, primary first, then oldest first. */
export function useNoteEvents(noteId: string): SyncListResult<NoteEventLink[]> {
  const all = useAllNoteEvents();
  const data = all.data
    ?.filter((l) => l.noteId === noteId)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  return { ...all, data };
}

export function useLinkNoteEvent(
  noteId: string,
): SyncMutationResult<{ event: CalendarEvent; isPrimary?: boolean }, void> {
  const store = useSyncStore();
  const link = ({ event, isPrimary }: { event: CalendarEvent; isPrimary?: boolean }): void => {
    if (!event.key) {
      // A row from a server that predates the key cannot be keyed locally; nothing to link against.
      console.warn(`[sync] linkNoteEvent: event ${event.id} carries no key — ignored`);
      return;
    }
    store?.linkNoteEvent({
      noteId,
      event: { id: event.id, key: event.key, title: event.title, start: event.start, end: event.end, joinUrl: event.joinUrl },
      isPrimary,
    });
  };
  return {
    mutate: (vars, callbacks) => {
      link(vars);
      callbacks?.onSuccess?.();
    },
    mutateAsync: async (vars) => link(vars),
    isPending: false,
  };
}

export function useSetPrimaryNoteEvent(noteId: string): SyncMutationResult<string, void> {
  const store = useSyncStore();
  return {
    mutate: (eventKey, callbacks) => {
      store?.setPrimaryNoteEvent(noteId, eventKey);
      callbacks?.onSuccess?.();
    },
    mutateAsync: async (eventKey) => void store?.setPrimaryNoteEvent(noteId, eventKey),
    isPending: false,
  };
}

/** Unlink; `decline` is the undo of an automatic link (the event is never suggested again). */
export function useUnlinkNoteEvent(
  noteId: string,
): SyncMutationResult<{ eventKey: string; decline?: boolean }, void> {
  const store = useSyncStore();
  return {
    mutate: ({ eventKey, decline }, callbacks) => {
      store?.unlinkNoteEvent(noteId, eventKey, { decline });
      callbacks?.onSuccess?.();
    },
    mutateAsync: async ({ eventKey, decline }) =>
      void store?.unlinkNoteEvent(noteId, eventKey, { decline }),
    isPending: false,
  };
}
