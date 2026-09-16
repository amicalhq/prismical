import type { Editor } from '@tiptap/core';
import { create } from 'zustand';

/** A session affordance for the existing Undo path, not document history. */
export const useNoteCreatedNotice = create<{
  expiresAt: number | null;
  notice: {
    noteId: string;
    artifactId: string;
    undoPending?: boolean;
    undoing?: boolean;
    message?: string;
    description?: string;
    error?: boolean;
    ownerKey?: string | null;
    orgId?: string | null;
    undo?: (editor: Editor) => void;
  } | null;
}>(() => ({ notice: null, expiresAt: null }));

// The store owns expiry while the note is open. The surface clears its notice
// when navigation leaves the note; returning must not revive old feedback.
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
useNoteCreatedNotice.subscribe((state, previous) => {
  if (state.notice === previous.notice) return;
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  const notice = state.notice;
  // Keep a failed/in-flight Undo recoverable until its sync completes.
  if (!notice || notice.undoPending || notice.undoing || notice.error) {
    useNoteCreatedNotice.setState({ expiresAt: null });
    return;
  }
  useNoteCreatedNotice.setState({ expiresAt: Date.now() + 10_000 });
  expiryTimer = setTimeout(() => {
    useNoteCreatedNotice.setState(current => ({
      notice: current.notice === notice && !current.notice.undoPending ? null : current.notice,
    }));
  }, 10_000);
});
