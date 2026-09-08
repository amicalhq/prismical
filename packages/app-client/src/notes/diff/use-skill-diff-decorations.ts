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
  const decoratedForRef = useRef<string | null>(null);
  // The candidate key we have already warned about, so a retry loop can't stack toasts.
  const warnedForRef = useRef<string | null>(null);

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
    // when the candidate can't be previewed against this document right now.
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

    // A candidate that cannot be previewed is NOT discarded. It cost a model call (for Enhance,
    // a whole recording), and the usual reasons the diff won't build are transient: the Y.Doc has
    // not synced yet, or a remote replace is mid-flight. Warn once, leave the candidate staged,
    // and let the transaction listener below retry as the document settles. The review bar stays
    // up, so Undo remains the user's way out if it never resolves.
    const warnPreviewUnavailable = () => {
      if (warnedForRef.current === key) return;
      warnedForRef.current = key;
      toast.error(
        candidate.mode === "inline-rewrite"
          ? t("skills.diff.previewRewriteFailed")
          : t("skills.diff.previewRunFailed"),
      );
    };

    if (applyDecorations()) {
      decoratedForRef.current = key;
      warnedForRef.current = null;
    } else warnPreviewUnavailable();

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
        // Also the RECOVERY path: a candidate that could not be previewed on mount gets another
        // attempt on every doc change, so the overlay appears as soon as the document is usable.
        if (applyDecorations()) {
          decoratedForRef.current = key;
          // A preview that works again re-arms the warning: a target the user really does delete
          // later must be reported, not swallowed by the first attempt's toast.
          warnedForRef.current = null;
          return;
        }
        // Drop a set we can no longer justify: the previous overlay was mapped through this change
        // and would sit on the doc claiming a proposal we can't rebuild. The candidate itself stays.
        if (decoratedForRef.current === key) {
          clearDiffDecorations(editor);
          decoratedForRef.current = null;
        }
        warnPreviewUnavailable();
      });
    };
    editor.on("transaction", onTransaction);

    // Scroll to where an appended diff begins so users at the top of a long note see the proposal.
    if (candidate.mode === "append-section" && decoratedForRef.current === key) {
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
  }, [editor, candidate, noteId, t]);
}

export function clearDiffDecorations(editor: Editor): void {
  const { state, view } = editor;
  view.dispatch(state.tr.setMeta(skillDiffPluginKey, "clear"));
}
