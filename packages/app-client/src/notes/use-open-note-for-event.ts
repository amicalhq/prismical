"use client";

import * as React from "react";
import { useNavigation } from "../ports-context";
import { useNotes, useCreateNote } from "../api/hooks/notes";

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
  const createNote = useCreateNote();

  const open = React.useCallback(
    (eventId: string) => {
      // Don't create against an unknown cache (unloaded/errored) — we couldn't dedup and would risk
      // a second note for the same event. `disabled` normally prevents reaching here in that state.
      if (!isSuccess || createNote.isPending) return;
      const existing = notes.find((n) => n.eventId === eventId);
      if (existing) {
        router.push(`/notes/${existing.id}`);
        return;
      }
      createNote.mutate(
        { eventId },
        { onSuccess: (note) => router.push(`/notes/${note.id}`) },
      );
    },
    [notes, isSuccess, createNote, router],
  );

  return { open, disabled: !isSuccess || createNote.isPending };
}
