"use client";

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useSkillDiffStore } from "./skill-diff-store";
import { skillDiffPluginKey } from "./diff-plugin";
import { buildCandidateTransaction, buildDiffDecorations } from "./build-decorations";
import { resolveVerifiedRange } from "./selection-anchors";

// Stable identity for a staged candidate. rawMarkdown is part of the key because a refine commonly
// produces a same-length-but-different replacement; bucketing by length alone leaves stale decos.
function candidateKey(c: { skillId: string; mode: string; rawMarkdown: string }): string {
  return `${c.mode}|${c.skillId}|${c.rawMarkdown}`;
}

// Applies / clears in-document diff decorations whenever the staged candidate for `noteId` changes.
// Cleanup handles the editor-swap case (note switch): the view is torn down by the time React runs
// cleanup, so we guard on `editor.isDestroyed`.
export function useSkillDiffDecorations(editor: Editor | null, noteId: string): void {
  const { t } = useTranslation();
  const candidate = useSkillDiffStore((s) => s.candidatesByNote.get(noteId));
  const clear = useSkillDiffStore((s) => s.clear);
  const decoratedForRef = useRef<string | null>(null);

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

    // (Re)compute + dispatch the decoration set against the CURRENT editor state. Returns false
    // when the candidate can't preview anymore (caller then clears it with a toast).
    const applyDecorations = (): boolean => {
      const view = editor.view;
      const state = view.state;
      // Inline-rewrite: re-resolve the target range from its Yjs anchors against the current doc —
      // the doc may have moved (local typing during the run, remote collaborators) since capture.
      // Verified: the range must still spell the captured selection text (else snap or fail).
      const inlineRange =
        candidate.mode === "inline-rewrite" && candidate.selectionAnchors
          ? resolveVerifiedRange(state, candidate.selectionAnchors, candidate.selectionText ?? "")
          : null;
      const tr = buildCandidateTransaction(state, candidate, inlineRange);
      if (!tr) return false;
      const decorations = buildDiffDecorations(state.doc, tr, state.schema);
      view.dispatch(view.state.tr.setMeta(skillDiffPluginKey, { decorations }));
      return true;
    };

    const failPreview = () => {
      toast.error(
        candidate.mode === "inline-rewrite"
          ? t("skills.diff.previewRewriteFailed")
          : t("skills.diff.previewRunFailed"),
      );
      clear(noteId);
    };

    if (!applyDecorations()) {
      failPreview();
      return;
    }
    decoratedForRef.current = key;

    // REBUILD on remote doc changes while staged. The plugin does map the set through incoming
    // transactions, but y-sync applies a remote update by replacing the whole changed range — any
    // decoration INSIDE that range is dropped by mapping, silently stripping the overlay while the
    // candidate stays staged. Recompute from scratch instead (rAF-coalesced: y-sync can dispatch
    // bursts). Local edits can't fire this — the editor lock blocks them while staged — and our
    // own setMeta dispatch has docChanged === false, so no feedback loop.
    let rebuildRaf: number | null = null;
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged || rebuildRaf !== null) return;
      rebuildRaf = requestAnimationFrame(() => {
        rebuildRaf = null;
        if (editor.isDestroyed) return;
        // The candidate may have been cleared between scheduling and firing (accept/reject).
        if (useSkillDiffStore.getState().candidatesByNote.get(noteId) !== candidate) return;
        if (!applyDecorations()) failPreview();
      });
    };
    editor.on("transaction", onTransaction);

    // Scroll to where an appended diff begins so users at the top of a long note see the proposal.
    if (candidate.mode === "append-section") {
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        const firstInsert = editor.view.dom.querySelector(".prismical-diff-insert");
        firstInsert?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    return () => {
      editor.off("transaction", onTransaction);
      if (rebuildRaf !== null) cancelAnimationFrame(rebuildRaf);
      if (!editor.isDestroyed) clearDiffDecorations(editor);
      decoratedForRef.current = null;
    };
  }, [editor, candidate, clear, noteId, t]);
}

export function clearDiffDecorations(editor: Editor): void {
  const { state, view } = editor;
  view.dispatch(state.tr.setMeta(skillDiffPluginKey, "clear"));
}
