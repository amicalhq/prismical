"use client";

import * as React from "react";
import type { Editor } from "@tiptap/react";

// The note body editor (NoteBodyEditor, rendered inside the page) publishes its live TipTap editor
// instance here so the LAYOUT-level dock cluster (recording-bottom-cluster → SkillDockSlot's run
// bridge / SkillDiffDockBar) can drive the same editor — run a skill, render the diff, apply on accept.
// Mirrors the current-note-context plumbing, keyed by noteId so a note switch can't have the old
// editor's unmount clear the new editor's registration.

type ActiveEditor = { noteId: string; editor: Editor };

type CurrentEditorContextValue = {
  /** The live editor for the note currently in view, or null when none is mounted/synced. */
  editor: Editor | null;
  /** The note id the live editor belongs to (guards against cross-note staleness). */
  editorNoteId: string | null;
  setActiveEditor: (noteId: string, editor: Editor) => void;
  clearActiveEditor: (noteId: string) => void;
};

const CurrentEditorContext = React.createContext<CurrentEditorContextValue | null>(null);

export function CurrentEditorProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = React.useState<ActiveEditor | null>(null);

  const setActiveEditor = React.useCallback((noteId: string, editor: Editor) => {
    setActive({ noteId, editor });
  }, []);

  // Only clear if the unmounting editor is still the registered one — a fast note switch mounts the
  // new editor before the old one's cleanup runs, and we must not wipe the new registration.
  const clearActiveEditor = React.useCallback((noteId: string) => {
    setActive((prev) => (prev && prev.noteId === noteId ? null : prev));
  }, []);

  const value = React.useMemo(
    () => ({
      editor: active?.editor ?? null,
      editorNoteId: active?.noteId ?? null,
      setActiveEditor,
      clearActiveEditor,
    }),
    [active, setActiveEditor, clearActiveEditor],
  );

  return (
    <CurrentEditorContext.Provider value={value}>{children}</CurrentEditorContext.Provider>
  );
}

export function useCurrentNoteEditor() {
  const ctx = React.useContext(CurrentEditorContext);
  if (!ctx) {
    throw new Error("useCurrentNoteEditor must be used within CurrentEditorProvider");
  }
  return ctx;
}

/** Publish the editor for `noteId` to the dock; clears it on unmount or when the editor changes. */
export function useRegisterNoteEditor(noteId: string, editor: Editor | null) {
  const { setActiveEditor, clearActiveEditor } = useCurrentNoteEditor();
  React.useEffect(() => {
    if (!editor) return;
    setActiveEditor(noteId, editor);
    return () => clearActiveEditor(noteId);
  }, [noteId, editor, setActiveEditor, clearActiveEditor]);
}
