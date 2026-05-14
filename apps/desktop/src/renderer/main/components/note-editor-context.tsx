import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Editor } from "@tiptap/core";

export type NoteEditorContextValue = {
  noteId: number;
  editor: Editor;
};

type Setter = (noteId: number, value: NoteEditorContextValue | null) => void;

// Two-context split mirrors current-note-context: the cluster subscribes to
// the value, but the publishing editor must not re-render when the value
// changes — otherwise registration would loop.
const NoteEditorValueContext = createContext<NoteEditorContextValue | null>(
  null,
);
const NoteEditorSetContext = createContext<Setter | null>(null);

export function NoteEditorProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<NoteEditorContextValue | null>(null);

  const set = useCallback<Setter>((noteId, value) => {
    setCurrent((prev) => {
      if (value === null) {
        return prev && prev.noteId === noteId ? null : prev;
      }
      return value;
    });
  }, []);

  return (
    <NoteEditorSetContext.Provider value={set}>
      <NoteEditorValueContext.Provider value={current}>
        {children}
      </NoteEditorValueContext.Provider>
    </NoteEditorSetContext.Provider>
  );
}

export function useNoteEditor(): NoteEditorContextValue | null {
  return useContext(NoteEditorValueContext);
}

// Called by note-editor.tsx to publish its editor instance to the cluster.
// Pass the editor — or null while it's being torn down / recreated — and
// the noteId; the hook handles the register/unregister lifecycle.
export function useRegisterNoteEditor(
  noteId: number,
  editor: Editor | null,
): void {
  const set = useContext(NoteEditorSetContext);
  if (!set) {
    throw new Error(
      "useRegisterNoteEditor must be used within NoteEditorProvider",
    );
  }
  useEffect(() => {
    if (!editor) return;
    set(noteId, { noteId, editor });
    return () => {
      set(noteId, null);
    };
  }, [set, noteId, editor]);
}
