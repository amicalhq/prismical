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
import { runSkillRequest, mutateTitleRun } from "../api/hooks/skill-runs";
import { ensureModelDefault } from "../api/hooks/model-defaults";
import {
  markdownToChildren,
  markdownToInlineChildren,
  tiptapJsonToMarkdown,
} from "@prismical/editor-markdown";
import { useSkillDiffStore } from "./diff/skill-diff-store";
import { useSkillRunActivityStore } from "./skill-run-activity-store";
import { EVENTS } from "../analytics-events";
import { usePorts } from "../ports-context";
import type { SelectionAnchors } from "./diff/selection-anchors";
import { ENHANCE_SKILL_ID, type ArtifactMode } from "@prismical/app-contracts";
import { retryTranscriptFinalizing } from "./skill-run-retry";

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
  outputTarget?: "note-body" | "note-title";
  skillId: string;
  skillName: string; // for the error/cancel toast
  /** Scope the transcript to a single recording: auto-enhance-on-stop or a picker wand. */
  recordingId?: string;
  /** Live editor markdown to send as the note body, for runs fired right
   * after typing. Omitted ⇒ the server reads its debounced snapshot. */
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
  const { analytics } = usePorts();
  const [running, setRunning] = useState(false);
  const acRef = useRef<AbortController | null>(null);

  // Transcript readiness can keep a run parked across several retries. Leaving the note/unmounting
  // must cancel that wait so its eventual result cannot stage into a stale editor.
  useEffect(
    () => () => {
      acRef.current?.abort();
    },
    [noteId],
  );

  const run = useCallback(
    async (args: RunSkillArgs) => {
      if (!editor && args.outputTarget !== "note-title") return;
      if (args.outputTarget === "note-title" && hasDirtyTitleDraft(noteId)) {
        toast.error(t("notes.titleConflict"));
        return;
      }
      // Copy the snapshot: Legend's peek value can be mutated by subsequent sync merges.
      const titleAtStart = { ...store?.notes$[noteId]?.peek() };
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      setRunning(true);
      // Also publish to the cross-instance activity store — the inline popover hides while ANY
      // run is in flight on this note, whichever surface started it.
      useSkillRunActivityStore.getState().start(noteId);
      try {
        // Resolve the Text-generation default (loads it if the query hasn't settled) so a BYOK
        // choice is never silently dropped on the first run.
        const modelParams = await ensureModelDefault(qc, "formatting");
        const result = await retryTranscriptFinalizing(() => {
          // A readiness wait may last long enough for the user to keep editing. Re-serialize on
          // every attempt so the first request the server accepts carries the current note, not
          // the snapshot captured before diarization began.
          let noteMarkdown: string | undefined;
          if (editor && (args.noteMarkdown !== undefined || args.outputTarget === "note-title")) {
            try {
              const current = tiptapJsonToMarkdown(editor.getJSON());
              noteMarkdown = current.length <= 1_000_000 ? current : undefined;
            } catch (err) {
              console.warn(
                "live markdown serialization failed; falling back to server snapshot",
                err,
              );
            }
          }
          return runSkillRequest(
            args.skillId,
            {
              noteId,
              recordingId: args.recordingId,
              noteMarkdown,
              mode: args.mode,
              selectionText: args.selectionText,
              refineInstruction: args.refineInstruction,
              previousOutput: args.previousOutput,
              ...modelParams,
            },
            ac.signal,
          );
        }, ac.signal);
        if (ac.signal.aborted) return;
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
          if (
            !hasDirtyTitleDraft(noteId) &&
            sameTitleIntent(titleAtStart, store?.notes$[noteId]?.peek())
          )
            merge(applied);
          toast.success(t("notes.titleUpdated"), {
            action: {
              label: t("notes.undoTitle"),
              onClick: () => {
                if (hasDirtyTitleDraft(noteId)) {
                  toast.error(t("notes.titleConflict"));
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
                  .catch(() => toast.error(t("notes.titleConflict")));
              },
            },
          });
          analytics.capture(EVENTS.SKILL_RUN, {
            skill_id: result.skillId,
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
          toast.error(t("skills.run.noUsableContent", { name: args.skillName }));
          return;
        }
        stage({
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
        analytics.capture(EVENTS.SKILL_RUN, {
          skill_id: result.skillId,
          skill_name: result.skillName,
          mode: result.mode,
          model_id: result.modelId,
          scoped_to_recording: !!result.recordingId,
        });
      } catch (err) {
        // User-initiated cancellation (abort) is not a failure — show no toast.
        if (ac.signal.aborted) return;
        if (err instanceof ApiError && err.code === "TITLE_CHANGED") {
          toast.error(t("notes.titleConflict"));
          return;
        }
        // Empty note isn't an error — it's a fixable state. Nudge, don't alarm.
        if (err instanceof ApiError && err.code === "NOTE_EMPTY") {
          const includesTranscript =
            (err.details as { includesTranscript?: boolean } | undefined)?.includesTranscript ??
            args.skillId === ENHANCE_SKILL_ID;
          // Enhance uses its transcript input when choosing the empty-state hint.
          toast.info(
            t(includesTranscript ? "skills.run.noteAndTranscriptEmpty" : "skills.run.noteEmpty", {
              name: args.skillName,
            }),
          );
          return;
        }
        // Scoped Enhance on a recording with no transcript (silent take / still processing) — a
        // fixable state, not a failure. Nudge, don't alarm. (The wand is hidden for empty recordings;
        // this is the server backstop, so keep the message neutral.)
        if (err instanceof ApiError && err.code === "NO_TRANSCRIPT") {
          toast.info(t("skills.run.noTranscript"));
          return;
        }
        if (err instanceof ApiError && err.code === "TRANSCRIPT_FINALIZING") {
          toast.info(t("skills.run.transcriptFinalizing"));
          return;
        }
        console.error("skill run failed", err);
        toast.error(t("skills.run.failed", { name: args.skillName }));
      } finally {
        useSkillRunActivityStore.getState().stop(noteId);
        if (acRef.current === ac) {
          setRunning(false);
          acRef.current = null;
        }
      }
    },
    [noteId, editor, stage, qc, analytics, t, store],
  );

  const cancel = useCallback(() => {
    acRef.current?.abort();
    acRef.current = null;
    setRunning(false);
  }, []);

  return { run, cancel, running };
}
