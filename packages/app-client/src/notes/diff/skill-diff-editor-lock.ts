import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
// @tiptap/y-tiptap, NOT y-prosemirror: the Collaboration extension registers its FORK's ySync
// plugin, and vanilla y-prosemirror's ySyncPluginKey is a different PluginKey instance — its
// getMeta lookup never matched, so this lock was silently blocking REMOTE transactions too
// (the exact CRDT desync the comment below warns about).
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { useSkillDiffStore } from "./skill-diff-store";

// While a skill-diff candidate is staged for this note, the editor's document is locked — editing
// under the diff overlay would invalidate the candidate's anchors and the visible diff would drift.
//
// We filter transactions rather than `editor.setEditable(false)` so the editor stays logically
// editable (cursor visible, keydown fires) while doc mutations are blocked.
//
// **Yjs adaptation (vs the desktop, which had no collaborators):** we must NEVER block a remote
// y-sync transaction — doing so would desync the CRDT (the local doc would diverge from the server
// + other clients). y-prosemirror tags the transactions it dispatches to apply remote updates with
// `ySyncPluginKey` meta; those always pass. Only LOCAL user edits (untagged docChanged txns) are
// blocked while a candidate is staged.
//
// The accept handler clears the candidate from the store BEFORE dispatching its own
// insertArtifactBlock / setContent, so the legitimate accept mutation passes through naturally.
export interface SkillDiffEditorLockOptions {
  noteId: string;
}

export const SkillDiffEditorLock = Extension.create<SkillDiffEditorLockOptions>({
  name: "skillDiffEditorLock",

  addOptions() {
    return { noteId: "" };
  },

  addProseMirrorPlugins() {
    const noteId = this.options.noteId;
    return [
      new Plugin({
        filterTransaction(tr) {
          if (!tr.docChanged) return true;
          // Remote Yjs updates carry the y-sync meta — always allow them.
          if (tr.getMeta(ySyncPluginKey) != null) return true;
          const candidate = useSkillDiffStore.getState().candidatesByNote.get(noteId);
          return !candidate;
        },
      }),
    ];
  },
});
