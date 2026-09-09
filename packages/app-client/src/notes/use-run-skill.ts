"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { onChangeRemote } from "@legendapp/state/sync";
import { useSyncStore } from "../sync/provider";
import type { NoteRow } from "../sync/store";
import { hasDirtyTitleDraft } from "./title-drafts";
import { runSkillRequest, mutateTitleRun, resolvePendingSkillResult } from "../api/hooks/skill-runs";
import { ensureModelDefault } from "../api/hooks/model-defaults";
import {
  markdownToChildren,
  markdownToInlineChildren,
  tiptapJsonToMarkdown,
} from "@prismical/editor-markdown";
import { useSkillDiffStore } from "./diff/skill-diff-store";
import { useSkillRunActivityStore, type SkillRunSource } from "./skill-run-activity-store";
import { startSkillRunTiming } from "./skill-run-timing";
import { EVENTS } from "../analytics-events";
import { usePorts } from "../ports-context";
import type { SelectionAnchors } from "./diff/selection-anchors";
import { ENHANCE_SKILL_ID, type ArtifactMode } from "@prismical/app-contracts";
import { retryTranscriptFinalizing } from "./skill-run-retry";
import { useAutoEnhanceStore } from "./auto-enhance-store";
import {
  aiErrorToastBody,
  aiUserErrorOf,
  bindAiErrorActions,
  isNetworkFailure,
} from "../errors/ai-user-error";
import { useNavigation } from "../ports-context";
import type { WorkflowAcknowledgment, WorkflowScope } from "@prismical/app-workflow";

type TitleState = Pick<NoteRow, "title" | "titleSource" | "titleRevision">;
function sameTitleIntent(before: TitleState | undefined, current: TitleState | undefined) {
  if (!before || !current || (before.titleRevision ?? 0) !== (current.titleRevision ?? 0))
    return false;
  const followsBody = (value: TitleState) =>
    value.titleSource === "placeholder" || value.titleSource === "first-line";
  // Autosave can update the displayed default while the model is running. Only an
  // explicit naming change invalidates that run; legacy/manual titles stay exact.
  return (
    (followsBody(before) && followsBody(current)) ||
    (before.title === current.title && before.titleSource === current.titleSource)
  );
}

export interface RunSkillArgs {
  /** Reserved recording-to-enhancement continuation; never a new admission. */
  workflowId?: string;
  /** The exact proposal being refined. */
  proposalId?: string;
  requestedAt?: number;
  attemptId?: string;
  outputTarget?: "note-body" | "note-title";
  skillId: string;
  skillName: string; // for the error/cancel toast
  /** Scope the transcript to a single recording: auto-enhance-on-stop or a picker wand. */
  recordingId?: string;
  /** Requests fresh editor markdown for legacy callers. Workflow-owned body runs always
   * serialize the editor and fail if its current body cannot be sent. */
  noteMarkdown?: string;
  /** Override the skill's default mode (the picker's mode submenu / the inline popover). */
  mode?: ArtifactMode;
  /** inline-rewrite: the highlighted text (model input) + its Yjs relative anchors
   * (where accept replaces). Both required for an inline run; captured by the popover. */
  selectionText?: string;
  selectionAnchors?: SelectionAnchors;
  /** Refine flow: re-run with an instruction + the previous output. */
  refineInstruction?: string;
  previousOutput?: string;
  /** Where the run was started from (dock v3 run feed + analytics). Defaults to "dock". */
  source?: SkillRunSource;
  /**
   * Run on Prismical Cloud for THIS run only, ignoring the saved BYOK default — the "Use
   * Prismical Cloud" recovery action after the user's own key failed. Never changes the default.
   */
  forceCloud?: boolean;
}

/**
 * Runs a skill against the current note and stages the result as a diff candidate. Owns an
 * AbortController so the Stop button cancels the in-flight (billable) request — the server aborts
 * the model call when the connection closes. Shared by the sparkle button (initial run) and the
 * diff dock bar (refine). The diff overlay itself is driven by the staged candidate via
 * useSkillDiffDecorations on the editor.
 */
export function useRunSkill(noteId: string, editor: Editor | null) {
  const { t } = useTranslation();
  const store = useSyncStore();
  const stage = useSkillDiffStore((s) => s.stage);
  // The user's Text-generation (formatting) default drives which model skills run on.
  const qc = useQueryClient();
  const { analytics, workflow, recording } = usePorts();
  const navigation = useNavigation();
  const [running, setRunning] = useState(false);
  const acRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const currentNoteRef = useRef(noteId);
  currentNoteRef.current = noteId;
  // `run` is referenced by the recovery actions it hands out (Try again, Use Prismical Cloud,
  // Append instead) — through a ref so the callbacks never capture a stale instance.
  const runRef = useRef<(args: RunSkillArgs) => Promise<void>>(async () => {});

  // Transcript readiness can keep a run parked across several retries. Leaving the note/unmounting
  // must cancel that wait so its eventual result cannot stage into a stale editor.
  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        acRef.current?.abort("unmounted");
      };
    },
    [noteId],
  );

  const run = useCallback(
    async (args: RunSkillArgs) => {
      const releaseReservedContinuation = () => {
        if (!workflow || !args.workflowId) return;
        const current = workflow.getSnapshot();
        if (current.kind === "skill" && current.phase === "running" &&
            current.workflowId === args.workflowId && current.noteId === noteId &&
            current.skillId === args.skillId && current.recordingId === args.recordingId &&
            !useSkillRunActivityStore.getState().runningByNote.has(noteId)) {
          workflow.dispatch({ type: "skillFailed", workflowId: current.workflowId, attempt: current.attempt });
        }
      };
      if (workflow && (!mountedRef.current || editor?.isDestroyed)) {
        releaseReservedContinuation();
        return;
      }
      const timing = startSkillRunTiming(
        analytics,
        {
          skill_id: args.skillId,
          note_id: noteId,
          recording_id: args.recordingId,
          source: args.source ?? "dock",
          output_target: args.outputTarget ?? "note-body",
        },
        undefined,
        args.requestedAt,
        args.attemptId,
      );
      if (!editor && args.outputTarget !== "note-title") {
        timing.finish("skipped", "EDITOR_UNAVAILABLE");
        releaseReservedContinuation();
        return;
      }
      if (args.outputTarget === "note-title" && hasDirtyTitleDraft(noteId)) {
        timing.finish("skipped", "TITLE_CHANGED");
        toast.error(t("notes.titleConflict"));
        releaseReservedContinuation();
        return;
      }
      let workflowScope: WorkflowScope | undefined;
      if (workflow) {
        const current = workflow.getSnapshot();
        const candidate = useSkillDiffStore.getState().getCandidate(noteId);
        let admitted: WorkflowAcknowledgment;
        if (args.workflowId) {
          admitted = {
            accepted:
              current.kind === "skill" && current.phase === "running" &&
              current.workflowId === args.workflowId && current.noteId === noteId &&
              current.skillId === args.skillId && current.recordingId === args.recordingId &&
              !useSkillRunActivityStore.getState().runningByNote.has(noteId),
            state: current,
          };
        } else if (args.source === "refine") {
          admitted = current.kind === "skill" && current.noteId === noteId && current.skillId === args.skillId &&
            !candidate?.acceptance &&
            candidate?.workflowId === current.workflowId && candidate.proposalId &&
            candidate.proposalId === current.proposalId && args.proposalId === candidate.proposalId
              ? workflow.dispatch({ type: "refineSkill", workflowId: current.workflowId, proposalId: candidate.proposalId })
              : { accepted: false, state: current };
        } else {
          admitted = workflow.dispatch({
            type: "runSkill", workflowId: crypto.randomUUID(), noteId, skillId: args.skillId,
          });
        }
        if (!admitted.accepted || admitted.state.kind !== "skill") {
          timing.finish("skipped", "WORKFLOW_BUSY");
          toast.info(t("workflow.busy", { defaultValue: "Finish the current recording or skill first." }));
          return;
        }
        workflowScope = {
          workflowId: admitted.state.workflowId,
          attempt: admitted.state.attempt,
        };
      }
      const previousCandidate = args.source === "refine"
        ? useSkillDiffStore.getState().getCandidate(noteId)
        : undefined;
      let workflowOutcome: "skillNoChange" | "skillFailed" = "skillFailed";
      let baseContent: string | undefined;
      const retryRun = (overrides: Partial<RunSkillArgs> = {}) => {
        if (workflow && (!mountedRef.current || currentNoteRef.current !== noteId)) return;
        void runRef.current({
          ...args, ...overrides, workflowId: undefined, requestedAt: undefined, attemptId: undefined,
        });
      };
      let errorCode: string | undefined;
      const onAbort = () =>
        timing.finish(
          ac.signal.reason === "unmounted"
            ? "abandoned"
            : ac.signal.reason === "superseded"
              ? "superseded"
              : "stopped",
        );
      // Copy the snapshot: sync merges can mutate the original object.
      const titleAtStart = { ...store?.notes$[noteId]?.peek() };
      acRef.current?.abort("superseded");
      const ac = new AbortController();
      acRef.current = ac;
      ac.signal.addEventListener("abort", onAbort, { once: true });
      // Only a FRESH recording-scoped run is what the transcript bar's Enhance chip re-runs, so
      // only those participate in its failure marker. Refining an already-staged diff also carries
      // a recordingId, but re-showing that bar mid-review would offer a chip that can do nothing
      // but toast "you already have a suggestion" until the diff is resolved.
      const retryableFromTranscriptBar =
        args.recordingId !== undefined && args.refineInstruction === undefined;
      // A new attempt supersedes any earlier failure for the same recording, so the marker never
      // outlives the condition it describes.
      if (retryableFromTranscriptBar) {
        useAutoEnhanceStore.getState().clearFailed(args.recordingId!);
        useAutoEnhanceStore.getState().clearWaiting(args.recordingId!);
      }
      setRunning(true);
      // Also publish to the cross-instance activity store — the inline popover hides while ANY
      // run is in flight on this note, whichever surface started it.
      const activity = useSkillRunActivityStore.getState();
      activity.start(noteId);
      const source = args.source ?? "dock";
      const recoverable = (!workflow || !!recording.control) && (
        source === "auto-enhance" || source === "wand" ||
        (source === "refine" && !!previousCandidate?.recoverable)
      );
      // Note-body runs also open a run-feed record: the Ask thread renders it as a turn
      // and the collapsed Ask pill shows it with a Stop. Title runs stay out of the feed (see the
      // store's header comment).
      const feedId =
        args.outputTarget === "note-title"
          ? null
          : activity.begin({
              noteId,
              skillId: args.skillId,
              skillName: args.skillName,
              instruction: args.refineInstruction,
              source,
              cancel: () => {
                ac.abort();
                if (acRef.current === ac) {
                  acRef.current = null;
                  setRunning(false);
                }
              },
            });
      // Idempotent: the first terminal status wins, so the explicit calls below beat the
      // catch-all in `finally`.
      const finish = (
        status: Parameters<typeof activity.finish>[1],
        detail?: string,
        extra?: Parameters<typeof activity.finish>[3],
      ) => {
        if (status === "applied" || status === "skipped") workflowOutcome = "skillNoChange";
        timing.finish(status, errorCode);
        if (feedId) activity.finish(feedId, status, detail, extra);
      };
      try {
        // Resolve the Text-generation default (loads it if the query hasn't settled) so a BYOK
        // choice is never silently dropped on the first run. `forceCloud` (the "Use Prismical
        // Cloud" recovery action) sends no instance at all, which the server resolves to Auto.
        const modelParams = args.forceCloud ? {} : await ensureModelDefault(qc, "formatting");
        const result = await retryTranscriptFinalizing(async () => {
          // A readiness wait may last long enough for the user to keep editing. Re-serialize on
          // every attempt so the first request the server accepts carries the current note, not
          // the snapshot captured before diarization began.
          let noteMarkdown: string | undefined;
          if (editor && (workflow || args.noteMarkdown !== undefined || args.outputTarget === "note-title")) {
            try {
              const content = editor.getJSON();
              if (workflow) baseContent = JSON.stringify(content);
              const current = tiptapJsonToMarkdown(content);
              if (workflow && current.length > 1_000_000)
                throw new Error("The current note exceeds the skill input limit.");
              noteMarkdown = current.length <= 1_000_000 ? current : undefined;
            } catch (err) {
              if (workflow) throw err;
              console.warn(
                "live markdown serialization failed; falling back to server snapshot",
                err,
              );
            }
          }
          timing.request();
          if (feedId) activity.setPhase(feedId, "running");
          try {
            return await runSkillRequest(
              args.skillId,
              {
                noteId,
                recordingId: args.recordingId,
                // Retain the server result identity for idempotent acceptance.
                // Native recording suggestions also remain available after an app restart.
                retainResult: workflow ? true : undefined,
                recoverable,
                recoveryResultId: !workflow && args.refineInstruction
                  ? (previousCandidate?.acceptance ? undefined : useSkillDiffStore.getState().getCandidate(noteId)?.resultId)
                  : undefined,
                noteMarkdown,
                mode: args.mode,
                selectionText: args.selectionText,
                refineInstruction: args.refineInstruction,
                previousOutput: args.previousOutput,
                ...modelParams,
              },
              ac.signal,
              timing.response,
            );
          } catch (err) {
            if (err instanceof ApiError && err.code === "TRANSCRIPT_FINALIZING") {
              timing.transition("waiting-transcript");
              if (feedId) activity.setPhase(feedId, "waiting-transcript");
            }
            throw err;
          }
        }, ac.signal);
        if (ac.signal.aborted) return;
        if (workflowScope) {
          const current = workflow!.getSnapshot();
          if (current.kind !== "skill" || current.phase !== "running" ||
              current.workflowId !== workflowScope.workflowId || current.attempt !== workflowScope.attempt)
            return;
        }
        timing.model(result.modelId);
        timing.transition("staging");
        if (result.outputTarget === "note-title") {
          if (
            !result.titleRunId ||
            hasDirtyTitleDraft(noteId) ||
            !sameTitleIntent(titleAtStart, store?.notes$[noteId]?.peek())
          ) {
            toast.error(t("notes.titleConflict"));
            return;
          }
          const runId = result.titleRunId;
          const merge = (value: Awaited<ReturnType<typeof mutateTitleRun>>) => {
            if (!store || !store.notes$[noteId]?.peek()) return;
            onChangeRemote(() =>
              store.notes$[noteId]!.assign({
                title: value.title,
                titleSource: value.titleSource,
                titleRevision: value.titleRevision,
              }),
            );
          };
          const applied = await mutateTitleRun("apply", runId);
          if (workflow && ac.signal.aborted) return;
          if (
            !hasDirtyTitleDraft(noteId) &&
            sameTitleIntent(titleAtStart, store?.notes$[noteId]?.peek())
          )
            merge(applied);
          toast.success(t("notes.titleUpdated"), {
            action: {
              label: t("notes.undoTitle"),
              onClick: () => {
                if (workflow && (!mountedRef.current || currentNoteRef.current !== noteId)) return;
                if (hasDirtyTitleDraft(noteId)) {
                  toast.error(t("notes.titleConflict"));
                  return;
                }
                const undo = workflow?.dispatch({
                  type: "runSkill", workflowId: crypto.randomUUID(), noteId, skillId: args.skillId,
                });
                if (undo && (!undo.accepted || undo.state.kind !== "skill")) {
                  toast.info(t("workflow.busy", { defaultValue: "Finish the current recording or skill first." }));
                  return;
                }
                const titleBeforeUndo = { ...store?.notes$[noteId]?.peek() };
                void mutateTitleRun("undo", runId)
                  .then((value) => {
                    if (
                      !hasDirtyTitleDraft(noteId) &&
                      sameTitleIntent(titleBeforeUndo, store?.notes$[noteId]?.peek())
                    )
                      merge(value);
                  })
                  .catch(() => toast.error(t("notes.titleConflict")))
                  .finally(() => {
                    if (undo?.accepted && undo.state.kind === "skill")
                      workflow?.dispatch({ type: "skillNoChange", workflowId: undo.state.workflowId, attempt: undo.state.attempt });
                  });
              },
            },
          });
          // Only reachable with a feed record when the CALLER didn't know the target was the
          // title (the server decides) — close it as applied rather than letting the catch-all
          // in `finally` read a successful title run as an error.
          finish("applied");
          analytics.capture(EVENTS.SKILL_RUN, {
            skill_id: result.skillId,
            source,
            output_target: "note-title",
            model_id: result.modelId,
          });
          return;
        }
        if (!editor) return;
        // Inline output must be a single paragraph's inline children (the wrapper is inline-only);
        // the strict converter rejects headings/lists/multi-paragraph so a wayward emission fails
        // the run instead of corrupting the note.
        const content =
          result.mode === "inline-rewrite"
            ? markdownToInlineChildren(result.rawMarkdown)
            : markdownToChildren(result.rawMarkdown);
        if (content.length === 0) {
          const msg = t("skills.run.noUsableContent", { name: args.skillName });
          toast.error(msg);
          finish("error", msg);
          return;
        }
        const proposalId = workflowScope ? crypto.randomUUID() : undefined;
        if (workflow && workflowScope && !workflow.dispatch({
          type: "proposalReady", ...workflowScope, proposalId: proposalId!,
        }).accepted) return;
        stage({
          workflowId: workflowScope?.workflowId,
          proposalId,
          baseContent: result.mode === "replace-doc" ? baseContent : undefined,
          resultId: result.resultId,
          recoverable: recoverable && !!result.recordingId,
          noteId,
          skillId: result.skillId,
          skillName: result.skillName,
          // Server echo ONLY (authoritative — it sets this exactly when the transcript actually
          // scoped to that recording, i.e. the recording had final segments). Do NOT fall back to
          // args.recordingId: a silent recording (or a non-transcript skill) contributed nothing, so
          // the artifact must stay unstamped or folded-detection would mark it "in note" falsely.
          recordingId: result.recordingId,
          mode: result.mode,
          modelId: result.modelId,
          reasoning: result.reasoning,
          refineInstruction: args.refineInstruction ?? null,
          selectionText: args.selectionText ?? null,
          selectionAnchors: args.selectionAnchors,
          usage: result.usage,
          content,
          rawMarkdown: result.rawMarkdown,
        });
        const previousResultId = previousCandidate?.resultId;
        if (workflow && previousResultId) {
          const retire = async () => {
            try {
              await resolvePendingSkillResult(noteId, previousResultId, { discardAccepted: true });
            } catch {
              toast.error(t("skills.diff.couldNotSave", { name: args.skillName }), {
                action: { label: t("common.actions.retry"), onClick: () => void retire() },
              });
            }
          };
          void retire();
        }
        finish("staged");
        // The run succeeded but the server has something the user should know (it fell back to
        // Prismical Cloud because their chosen model is gone). Server-rendered, like the errors.
        if (result.notice) {
          const [primary] = bindAiErrorActions(result.notice.actions, {
            "choose-model": () => navigation.push("/settings/ai-models"),
            "open-ai-models": () => navigation.push("/settings/ai-models"),
            "open-billing": () => navigation.push("/settings/billing"),
          });
          toast.info(result.notice.title, {
            description: result.notice.body,
            ...(primary ? { action: { label: primary.label, onClick: primary.onClick } } : {}),
          });
        }
        analytics.capture(EVENTS.SKILL_RUN, {
          skill_id: result.skillId,
          skill_name: result.skillName,
          source,
          mode: result.mode,
          model_id: result.modelId,
          scoped_to_recording: !!result.recordingId,
        });
      } catch (err) {
        if (err instanceof ApiError && err.requestId) timing.response(err.requestId);
        errorCode =
          err instanceof ApiError
            ? err.code
            : isNetworkFailure(err)
              ? "NETWORK_ERROR"
              : "CLIENT_ERROR";
        // User-initiated cancellation (abort) is not a failure — show no toast.
        if (ac.signal.aborted) return;
        // Whatever the toast below says, republish the outcome before returning down any of these
        // branches: the transcript bar's Enhance chip is that recording's only retry affordance and
        // it sits on a dismiss timer. A run that ran out its transcript-readiness budget is PARKED,
        // not failed: the server's finalize work continues and the bar re-fires the run itself
        // once that settles — it must never read as an error.
        const parked = err instanceof ApiError && err.code === "TRANSCRIPT_FINALIZING";
        const emptyInput =
          err instanceof ApiError && (err.code === "NO_TRANSCRIPT" || err.code === "NOTE_EMPTY");
        if (retryableFromTranscriptBar && emptyInput) {
          useAutoEnhanceStore.getState().clearFailed(args.recordingId!);
          useAutoEnhanceStore.getState().clearWaiting(args.recordingId!);
        }
        if (retryableFromTranscriptBar && !emptyInput) {
          if (parked) useAutoEnhanceStore.getState().markWaiting(args.recordingId!);
          else useAutoEnhanceStore.getState().markFailed(args.recordingId!);
        }
        if (parked && retryableFromTranscriptBar) {
          // The transcript bar carries the parked state (and re-fires the run when the transcript
          // settles), so no toast on top of it — the server's `details.user` copy below would
          // otherwise render one. A bare whole-note run has no bar and keeps the toast.
          finish("skipped", t("skills.run.transcriptFinalizing"));
          return;
        }
        // The server describes AI failures for the user — localized title/body, severity, and the
        // recovery actions to offer (`details.user`). Render that as-is: the client only binds the
        // action kinds it can perform. Everything below this block is the fallback for servers
        // that predate it (and for failures that never reached core).
        const user = aiUserErrorOf(err);
        if (user) {
          const actions = bindAiErrorActions(user.actions, {
            retry: () => retryRun(),
            "use-cloud": () => retryRun({ forceCloud: true }),
            "append-instead": () => retryRun({ mode: "append-section" }),
            "open-ai-models": () => navigation.push("/settings/ai-models"),
            "choose-model": () => navigation.push("/settings/ai-models"),
            "open-billing": () => navigation.push("/settings/billing"),
          });
          // The first action is the toast's button; any further action is a link in the body.
          // (sonner's `cancel` slot renders BEFORE `action` and styled as a dismiss, which would
          // invert the server's order and make "Use Prismical Cloud" look like Cancel.)
          const [primary, ...more] = actions;
          const toastOpts = {
            description: aiErrorToastBody(user.body, more),
            ...(primary ? { action: { label: primary.label, onClick: primary.onClick } } : {}),
          };
          if (user.severity === "info") toast.info(user.title, toastOpts);
          else if (user.severity === "warning") toast.warning(user.title, toastOpts);
          else toast.error(user.title, toastOpts);
          finish(user.severity === "info" ? "skipped" : "error", user.title, {
            body: user.body,
            actions,
          });
          return;
        }
        if (isNetworkFailure(err)) {
          const msg = t("skills.run.offline");
          toast.error(msg, {
            description: t("skills.run.offlineBody"),
            action: {
              label: t("common.actions.retry"),
              onClick: () => retryRun(),
            },
          });
          finish("error", msg, {
            body: t("skills.run.offlineBody"),
            actions: [
              {
                kind: "retry",
                label: t("common.actions.retry"),
                onClick: () => retryRun(),
              },
            ],
          });
          return;
        }
        if (err instanceof ApiError && err.code === "TITLE_CHANGED") {
          const msg = t("notes.titleConflict");
          toast.error(msg);
          finish("error", msg);
          return;
        }
        // Empty note isn't an error — it's a fixable state. Nudge, don't alarm.
        if (err instanceof ApiError && err.code === "NOTE_EMPTY") {
          const includesTranscript =
            (err.details as { includesTranscript?: boolean } | undefined)?.includesTranscript ??
            args.skillId === ENHANCE_SKILL_ID;
          // Enhance uses its transcript input when choosing the empty-state hint.
          const msg = t(
            includesTranscript ? "skills.run.noteAndTranscriptEmpty" : "skills.run.noteEmpty",
            { name: args.skillName },
          );
          toast.info(msg);
          finish("skipped", msg);
          return;
        }
        // Scoped Enhance on a recording with no transcript (silent take / still processing) — a
        // fixable state, not a failure. Nudge, don't alarm. (The wand is hidden for empty recordings;
        // this is the server backstop, so keep the message neutral.)
        if (err instanceof ApiError && err.code === "NO_TRANSCRIPT") {
          const msg = t("skills.run.noTranscript");
          toast.info(msg);
          finish("skipped", msg);
          return;
        }
        if (parked) {
          const msg = t("skills.run.transcriptFinalizing");
          toast.info(msg);
          finish("skipped", msg);
          return;
        }
        console.error("skill run failed", err);
        const msg = t("skills.run.failed", { name: args.skillName });
        toast.error(msg);
        finish("error", msg);
      } finally {
        // Once staged, only review actions can release ownership. A failed refine
        // returns to its previous proposal instead of freeing the workflow.
        if (workflowScope) workflow?.dispatch({
          type: ac.signal.aborted ? "skillCancelled" : workflowOutcome,
          ...workflowScope,
        });
        // Catch-all so a record can never stay "running": an abort is the user's Stop; any other
        // early return (no editor, a silent bail) reads as a failure with no detail.
        finish(ac.signal.aborted ? "stopped" : "error");
        ac.signal.removeEventListener("abort", onAbort);
        useSkillRunActivityStore.getState().stop(noteId);
        if (acRef.current === ac) {
          setRunning(false);
          acRef.current = null;
        }
      }
    },
    [noteId, editor, stage, qc, analytics, t, store, navigation, workflow, recording.control],
  );
  runRef.current = run;

  const cancel = useCallback(() => {
    acRef.current?.abort();
    acRef.current = null;
    setRunning(false);
  }, []);

  return { run, cancel, running };
}
