import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { useSkillDiffStore } from "./skill-diff-store";

// While a skill-diff candidate is staged for this note, the editor's
// document is locked — editing under the diff overlay invalidates the
// candidate's anchors and the visible diff drifts out of sync with what
// the user is reviewing.
//
// We don't use `editor.setEditable(false)` because that drops
// `contenteditable` to false on the editor DOM, which makes the element
// non-focusable — keydown events then never fire on the editor and the
// "user is trying to edit" detection (in note-editor.tsx) can't run.
// Filtering transactions in ProseMirror keeps the editor logically
// editable (cursor still appears, keydown still fires) while blocking
// any doc mutation.
//
// Attention-pulse (the dock shake) is NOT fired from here — it would
// also pulse for system-driven mutations (yjs sync, plugin updates,
// completion of an accepted run) and feel like a warning at the wrong
// moments. Pulses fire only from the editor's user-input event handlers.
//
// The accept handler in the dock bar clears the candidate from the store
// BEFORE dispatching its own command transactions, so the legitimate
// insertArtifactBlock / setContent that lands an accepted run passes
// through naturally — by the time those run, the lock is no longer in
// effect for this noteId.
export interface SkillDiffEditorLockOptions {
  noteId: number;
}

export const SkillDiffEditorLock = Extension.create<SkillDiffEditorLockOptions>(
  {
    name: "skillDiffEditorLock",

    addOptions() {
      return { noteId: 0 };
    },

    addProseMirrorPlugins() {
      const noteId = this.options.noteId;
      return [
        new Plugin({
          filterTransaction(tr) {
            if (!tr.docChanged) return true;
            const candidate = useSkillDiffStore
              .getState()
              .candidatesByNote.get(noteId);
            return !candidate;
          },
        }),
      ];
    },
  },
);
