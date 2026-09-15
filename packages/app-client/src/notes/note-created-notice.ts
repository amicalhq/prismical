import type { Editor } from "@tiptap/core";
import { create } from "zustand";

/** A session affordance for the existing Undo path, not document history. */
export const useNoteCreatedNotice = create<{
  notice: { noteId: string; artifactId: string; undoPending?: boolean; ownerKey?: string | null; orgId?: string | null; undo: (editor: Editor) => void } | null;
}>(() => ({ notice: null }));
