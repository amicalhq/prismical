"use client";

import * as React from "react";
import { useNavigation } from "../ports-context";
import { useNotes, useCreateNote } from "../api/hooks/notes";
import { useAllNoteEvents } from "../api/hooks/note-events";
import { useCalendarEvents } from "../api/hooks/events";
import { useSyncStore } from "../sync/provider";

/**
 * Open the note for a calendar event (the "Create note" / "Notes" action on a meeting row).
 *
 * Find-or-create, mirroring the desktop `createNoteFromEvent` so a meeting maps to a SINGLE note:
 * if a note already links to `eventId`, navigate to it; otherwise create one (the server links it
 * and titles it from the event) and navigate to the new note. The notes list carries `eventId`, so
 * the lookup is a local cache scan — no extra request.
 *
 * The dedup is only trustworthy once the notes list has loaded — scanning an empty/unresolved cache
 * would miss an existing note and create a duplicate. So `open` no-ops until the notes query has
 * succeeded, and `disabled` keeps the button un-clickable while the list is loading or errored (as
 * well as while a create is in flight). Callers should spread `disabled` onto their button.
 */
export function useOpenNoteForEvent() {
  const router = useNavigation();
  const { data: notes = [], isSuccess } = useNotes();
  const { data: links = [] } = useAllNoteEvents();
  const { data: events = [] } = useCalendarEvents();
  const store = useSyncStore();
  const createNote = useCreateNote();

  const open = React.useCallback(
    (eventId: string) => {
      // Don't create against an unknown cache (unloaded/errored) — we couldn't dedup and would risk
      // a second note for the same event. `disabled` normally prevents reaching here in that state.
      if (!isSuccess || createNote.isPending) return;
      // Any readable note linked to this event counts — including one a collaborator linked
      // (links resolve to MY row for the event), primary links first; then the list's own
      // (creator-side) column for a note whose link row has not arrived yet.
      const noteIds = new Set(notes.map((n) => n.id));
      const linked = links
        .filter((l) => l.eventId === eventId && noteIds.has(l.noteId))
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
      const existing = linked
        ? notes.find((n) => n.id === linked.noteId)
        : notes.find((n) => n.eventId === eventId);
      if (existing) {
        router.push(`/notes/${existing.id}`);
        return;
      }
      createNote.mutate(
        { eventId },
        {
          onSuccess: (note) => {
            // The server links the note in the create itself; mirror that locally so the meeting
            // chip is on screen the moment the note opens (the link's own POST is an idempotent
            // upsert on the same pair, gated on the note's create ack).
            const event = events.find((e) => e.id === eventId);
            if (event?.key && store) store.linkNoteEvent({ noteId: note.id, event: { ...event, key: event.key }, isPrimary: true });
            router.push(`/notes/${note.id}`);
          },
        },
      );
    },
    [notes, links, events, store, isSuccess, createNote, router],
  );

  return { open, disabled: !isSuccess || createNote.isPending };
}
