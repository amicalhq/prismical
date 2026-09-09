'use client';

import * as React from 'react';

export interface AskNoteContext {
  id: string;
  title: string;
}

/** Automatic context follows the current visit; explicit mentions belong to the draft.
 * Reset during render so a newly opened note is available to the very next send, without
 * waiting for an effect. Renames and rerenders keep the user's removal decision. */
export function useAskNoteContext(currentNote: AskNoteContext | null, ownerKey: string) {
  const noteId = currentNote?.id ?? null;
  const [visit, setVisit] = React.useState({ noteId, ownerKey, included: true });
  const changed = visit.noteId !== noteId || visit.ownerKey !== ownerKey;
  if (changed) setVisit({ noteId, ownerKey, included: true });
  const included = changed || visit.included;
  const focusNote = included ? currentNote : null;

  const resolveNotes = (explicitNotes: AskNoteContext[] = []): AskNoteContext[] => {
    const notes = focusNote ? [focusNote, ...explicitNotes] : explicitNotes;
    return [...new Map(notes.map(note => [note.id, note])).values()];
  };

  return {
    focusNote,
    resolveNotes,
    remove: () => setVisit({ noteId, ownerKey, included: false }),
    restore: () => setVisit({ noteId, ownerKey, included: true }),
  };
}
