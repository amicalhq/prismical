"use client";
import { useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { markdownToChildren } from "@prismical/editor-markdown";
import { listPendingSkillResults } from "../api/hooks/skill-runs";
import { useActiveSessionKey, useActiveOrgId, usePorts, activeOrgIdOf } from "../ports-context";
import { useSkillDiffStore, type SkillDiffCandidate } from "./diff/skill-diff-store";

import { useSkillRunActivityStore } from "./skill-run-activity-store";

/** Recover only server-completed suggestions; never regenerate uncertain work. */
export function useRecoverSkillResult(noteId: string, editor: Editor | null) {
  const { auth } = usePorts();
  const session = useActiveSessionKey();
  const org = useActiveOrgId();
  useEffect(() => {
    const clearForeignRecovery = () => {
      const candidate = useSkillDiffStore.getState().getCandidate(noteId);
      const owner = candidate?.owner;
      if (!owner) return;
      const current = auth.getSession();
      if (
        (current.activeSessionKey ?? current.activeSub ?? null) !== owner.sessionKey ||
        activeOrgIdOf(current) !== owner.orgId
      ) {
        useSkillDiffStore.getState().clear(noteId);
        useSkillRunActivityStore.getState().resolveStaged(noteId, "undone");
      }
    };
    clearForeignRecovery();
    const unsubscribe = auth.onSessionChanged(clearForeignRecovery);
    if (!editor || !session || !org) return unsubscribe;
    let disposed = false;
    let busy = false;
    let currentRequest: AbortController | undefined;
    const mountedAt = Date.now();
    let lastAttempt = 0;
    const stillOwned = () => {
      const current = auth.getSession();
      return (
        (current.activeSessionKey ?? current.activeSub) === session &&
        activeOrgIdOf(current) === org
      );
    };
    const recover = async () => {
      if (
        !stillOwned() ||
        busy ||
        useSkillRunActivityStore.getState().runningByNote.has(noteId) ||
        useSkillDiffStore.getState().getCandidate(noteId)
      )
        return;
      const candidatesAtRequest = useSkillDiffStore.getState().candidatesByNote;
      busy = true;
      lastAttempt = Date.now();
      const controller = new AbortController();
      currentRequest = controller;
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const results = await listPendingSkillResults(noteId, controller.signal);
        if (
          disposed ||
          !stillOwned() ||
          candidatesAtRequest !== useSkillDiffStore.getState().candidatesByNote ||
          editor.isDestroyed ||
          useSkillRunActivityStore.getState().runningByNote.has(noteId) ||
          useSkillDiffStore.getState().getCandidate(noteId)
        )
          return;
        const result = results[0];
        if (!result || result.mode === "inline-rewrite") return;
        const content = markdownToChildren(result.rawMarkdown);
        if (!content.length) return;
        const activity = useSkillRunActivityStore.getState();
        const feed = activity.begin({
          noteId,
          skillId: result.skillId,
          skillName: result.skillName,
          source: "auto-enhance",
        });
        activity.finish(feed, "staged");
        const candidate: SkillDiffCandidate = {
          ...result,
          owner: { sessionKey: session, orgId: org },
          noteId,
          content,
          refineInstruction: result.refineInstruction ?? null,
          selectionText: null,
        };
        useSkillDiffStore.getState().stage(candidate);
      } catch {
        // A failed recovery request leaves the note editable; retry on the next poll/focus.
      } finally {
        clearTimeout(timeout);
        busy = false;
      }
    };
    void recover();
    const timer = setInterval(() => {
      const interval = Date.now() - mountedAt < 30_000 ? 3000 : 30_000;
      if (Date.now() - lastAttempt >= interval) void recover();
    }, 3000);
    window.addEventListener("focus", recover);
    window.addEventListener("online", recover);
    return () => {
      disposed = true;
      unsubscribe();
      currentRequest?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", recover);
      window.removeEventListener("online", recover);
    };
  }, [noteId, editor, session, org, auth]);
}
