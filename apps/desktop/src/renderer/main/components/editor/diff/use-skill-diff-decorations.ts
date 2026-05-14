import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useSkillDiffStore } from "./skill-diff-store";
import { skillDiffPluginKey } from "./diff-plugin";
import {
  buildCandidateTransaction,
  buildDiffDecorations,
} from "./build-decorations";

// Stable identity for a staged candidate. The full rawMarkdown is part of
// the key because a refine commonly produces a same-length-but-different
// replacement, and bucketing by length only would leave stale decorations
// in place.
type CandidateKey = string;
function candidateKey(c: {
  skillId: string;
  mode: string;
  rawMarkdown: string;
}): CandidateKey {
  return `${c.mode}|${c.skillId}|${c.rawMarkdown}`;
}

// Applies / clears in-document diff decorations whenever the staged
// candidate for `noteId` changes. The cleanup also handles the editor-swap
// case: when the editor is re-created (note switch), `editor.isDestroyed`
// will be true by the time React runs cleanup, so we skip the dispatch
// instead of throwing on a torn-down view.
export function useSkillDiffDecorations(
  editor: Editor | null,
  noteId: number,
): void {
  const candidate = useSkillDiffStore((s) => s.candidatesByNote.get(noteId));
  const clear = useSkillDiffStore((s) => s.clear);
  const decoratedForRef = useRef<CandidateKey | null>(null);

  useEffect(() => {
    if (!editor) return;
    if (!candidate) {
      if (decoratedForRef.current !== null) {
        clearDiffDecorations(editor);
        decoratedForRef.current = null;
      }
      return;
    }

    const key = candidateKey(candidate);
    if (decoratedForRef.current === key) return;

    // Read state at dispatch time, not effect time — between effect
    // queueing and now, a Yjs observer or another transaction may have
    // dispatched and our snapshot would be stale.
    const view = editor.view;
    const state = view.state;
    const tr = buildCandidateTransaction(state, candidate);
    if (!tr) {
      toast.error(
        "Couldn't preview this run — the editor state has moved on. Try running the skill again.",
      );
      clear(noteId);
      return;
    }
    const decorations = buildDiffDecorations(state.doc, tr, state.schema);
    view.dispatch(view.state.tr.setMeta(skillDiffPluginKey, { decorations }));
    decoratedForRef.current = key;

    return () => {
      if (!editor.isDestroyed) clearDiffDecorations(editor);
      decoratedForRef.current = null;
    };
  }, [editor, candidate, clear, noteId]);
}

export function clearDiffDecorations(editor: Editor): void {
  const { state, view } = editor;
  view.dispatch(state.tr.setMeta(skillDiffPluginKey, "clear"));
}
