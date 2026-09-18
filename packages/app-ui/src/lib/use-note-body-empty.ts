'use client';

import { useEditorState } from '@tiptap/react';
import { useCurrentNoteEditorIfAvailable } from '../shell/current-editor-context';

/**
 * Whether the live body of `noteId` has no text (whitespace-only counts as empty; the title lives
 * outside the body editor). `null` when that note's editor isn't mounted, so callers can pick a
 * conservative default. Re-renders only when the answer flips, not on every keystroke.
 */
export function useNoteBodyEmpty(noteId: string | null): boolean | null {
  const ctx = useCurrentNoteEditorIfAvailable();
  const live = ctx?.editor && noteId && ctx.editorNoteId === noteId ? ctx.editor : null;
  const empty = useEditorState({
    editor: live,
    // TipTap's snapshot can retain the previous editor until the next transaction.
    selector: () => live ? live.state.doc.textContent.trim().length === 0 : null,
  });
  return empty ?? null;
}
