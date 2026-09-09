"use client";
import { useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { markdownToChildren } from "@prismical/editor-markdown";
import { listPendingSkillResults } from "../api/hooks/skill-runs";
import { useActiveSessionKey, useActiveOrgId, usePorts, activeOrgIdOf } from "../ports-context";
import { useSkillDiffStore } from "./diff/skill-diff-store";

import { useSkillRunActivityStore } from "./skill-run-activity-store";

/** Recover only server-completed suggestions; never regenerate uncertain work. */
export function useRecoverSkillResult(noteId: string, editor: Editor | null) {
  const { auth, workflow, recording } = usePorts();
  const session = useActiveSessionKey();
  const org = useActiveOrgId();
  useEffect(() => {
    // Native recording persists completed suggestions across application restarts.
    if ((workflow && !recording.control) || !editor || !session || !org) return;
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
        (workflow && workflow.getSnapshot().kind !== "idle") ||
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
        const baseContent = workflow && result.mode === "replace-doc"
          ? JSON.stringify(editor.getJSON()) : undefined;
        const admitted = workflow?.dispatch({
          type: "runSkill", workflowId: crypto.randomUUID(), noteId, skillId: result.skillId,
        });
        if (admitted && (!admitted.accepted || admitted.state.kind !== "skill")) return;
        const scope = admitted?.state.kind === "skill" ? admitted.state : undefined;
        const proposalId = scope ? crypto.randomUUID() : undefined;
        if (scope && !workflow!.dispatch({
          type: "proposalReady", workflowId: scope.workflowId, attempt: scope.attempt,
          proposalId: proposalId!,
        }).accepted) return;
        const activity = useSkillRunActivityStore.getState();
        const feed = activity.begin({
          noteId,
          skillId: result.skillId,
          skillName: result.skillName,
          source: "auto-enhance",
        });
        activity.finish(feed, "staged");
        useSkillDiffStore.getState().stage({
          ...result,
          recoverable: true,
          baseContent,
          workflowId: scope?.workflowId,
          proposalId,
          noteId,
          content,
          refineInstruction: result.refineInstruction ?? null,
          selectionText: null,
        });
      } catch {
        // Offline and older servers leave the note editable; retry on the next poll/focus.
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
      currentRequest?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", recover);
      window.removeEventListener("online", recover);
    };
  }, [noteId, editor, session, org, auth, workflow, recording.control]);
}
