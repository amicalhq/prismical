"use client";

import * as React from "react";
import type { TranscriptLine } from "@prismical/app-contracts";

// The note-detail page registers the note currently in view so the
// layout-level <RecordingBottomCluster /> (a sibling of the page content) can
// render the dock + transcription panel for it — mirroring the desktop
// CurrentNoteContext / registerCurrentNote plumbing.

export type CurrentNote = {
  noteId: string;
  title: string;
  transcript: TranscriptLine[];
};

type CurrentNoteContextValue = {
  currentNote: CurrentNote | null;
  setCurrentNote: (note: CurrentNote | null) => void;
};

const CurrentNoteContext =
  React.createContext<CurrentNoteContextValue | null>(null);

export function CurrentNoteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [currentNote, setCurrentNote] = React.useState<CurrentNote | null>(
    null,
  );
  return (
    <CurrentNoteContext.Provider value={{ currentNote, setCurrentNote }}>
      {children}
    </CurrentNoteContext.Provider>
  );
}

export function useCurrentNote() {
  const ctx = React.useContext(CurrentNoteContext);
  if (!ctx) {
    throw new Error("useCurrentNote must be used within CurrentNoteProvider");
  }
  return ctx;
}

/** Publish the active note to the cluster; clears it on unmount. */
export function useRegisterCurrentNote(note: CurrentNote | null) {
  const { setCurrentNote } = useCurrentNote();
  const key = note
    ? `${note.noteId}|${note.title}|${note.transcript.length}`
    : null;
  React.useEffect(() => {
    setCurrentNote(note);
    return () => setCurrentNote(null);
    // `note` is reconstructed each render; `key` captures its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setCurrentNote]);
}
