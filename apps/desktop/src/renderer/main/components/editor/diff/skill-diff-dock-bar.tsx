import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  IconSparkles,
  IconCheck,
  IconX,
  IconWand,
  IconArrowsLeftRight,
  IconCornerDownLeft,
} from "@tabler/icons-react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { toast } from "sonner";
import { useSkillDiffStore } from "./skill-diff-store";
import { useSkillDiffToastStore } from "./skill-diff-toast-store";
import { clearDiffDecorations } from "./use-skill-diff-decorations";
import { api } from "@/trpc/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props {
  editor: Editor;
  noteId: number;
}

// Visual language matches NoteRecordingDock / SkillSparkleButton: 42px-tall
// dark pill, rounded-28, backdrop-blur, ring + soft shadow, with the same
// plain CSS hover-scale + width transition. Keeping the chrome animation
// CSS-only (no framer layout magic) avoids the shrink/expand wobble that
// shared-layout morphs produced when this swaps in/out of the dock slot.
const PILL_OUTER =
  "group h-[42px] bg-black/80 dark:bg-black/70 rounded-[28px] backdrop-blur-md " +
  "ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] " +
  "select-none flex items-center overflow-hidden " +
  "transition-all duration-200 ease-out hover:scale-[1.02]";

const INNER_BTN =
  "flex h-8 shrink-0 items-center justify-center rounded-full cursor-pointer " +
  "text-white/80 transition-colors hover:bg-white/15 hover:text-white " +
  "active:scale-95 disabled:cursor-not-allowed disabled:opacity-60";

// Quick tween for the inner accept-row <-> refine-input swap. Only the
// inner controls animate; the outer pill chrome is CSS-only above.
const INNER_TRANSITION = {
  duration: 0.12,
  ease: [0.32, 0.72, 0, 1] as [number, number, number, number],
};

export function SkillDiffDockBar({ editor, noteId }: Props) {
  const candidate = useSkillDiffStore((s) => s.candidatesByNote.get(noteId));
  const clear = useSkillDiffStore((s) => s.clear);
  const stage = useSkillDiffStore((s) => s.stage);
  const switchMode = useSkillDiffStore((s) => s.switchMode);
  const setAccepting = useSkillDiffStore((s) => s.setAccepting);
  const run = api.skillRuns.run.useMutation();
  const accept = api.skillRuns.accept.useMutation();
  const cancel = api.skillRuns.cancel.useMutation();

  const [refineMode, setRefineMode] = useState(false);
  const [refineText, setRefineText] = useState("");

  if (!candidate) return null;

  const onAccept = async () => {
    if (candidate.mode === "inline-rewrite") {
      const restored = restoreInlineSelection(editor, candidate);
      if (!restored) {
        toast.error(
          "The selection where this rewrite was run no longer exists. Re-highlight and try again.",
        );
        clearDiffDecorations(editor);
        clear(noteId);
        return;
      }
    }

    // Mark the candidate as mid-accept so handleKeyDown in note-editor.tsx
    // stops pulsing attention while we await the network call — the user
    // has already committed to the change, and a stray keystroke shouldn't
    // shake the dock at the moment of confirmation.
    setAccepting(noteId, true);

    let auditMeta: { artifactId: string; version: number; generatedAt: string };
    try {
      auditMeta = await accept.mutateAsync({
        noteId,
        skillSlug: candidate.skillId,
        mode: candidate.mode,
        content: JSON.stringify(candidate.content),
        rawMarkdown: candidate.rawMarkdown,
        modelId: candidate.modelId,
        modelInstanceId: candidate.modelInstanceId,
        providerType: candidate.providerType,
        refineInstruction: candidate.refineInstruction,
        selectionText: candidate.selectionText,
        reasoning: candidate.reasoning,
      });
    } catch (err) {
      toast.error(
        `Couldn't save ${candidate.skillName} run — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Leave the candidate staged so the user can retry — but unmark
      // isAccepting so a subsequent edit attempt does pulse normally.
      setAccepting(noteId, false);
      clearDiffDecorations(editor);
      return;
    }

    // Release the editor lock BEFORE dispatching the accept's command
    // transactions — SkillDiffEditorLock filters out mutating txns while
    // a candidate is staged. clearDiffDecorations also dispatches, so it
    // runs after clear() too.
    clear(noteId);

    if (candidate.mode === "append-section") {
      editor.commands.insertArtifactBlock({
        artifactId: auditMeta.artifactId,
        skillId: candidate.skillId,
        skillName: candidate.skillName,
        version: auditMeta.version,
        generatedAt: auditMeta.generatedAt,
        modelId: candidate.modelId,
        content: candidate.content,
      });
      // The new section can land below the fold on long notes. TipTap's
      // built-in `focus("end")` only does an instant scroll-into-view; do
      // the scroll manually on rAF so we get the smooth behaviour and so
      // the editor has applied the insert before we read its DOM. Also
      // surface a transient toast above the dock so users who weren't
      // looking at the bottom still notice.
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        const last = editor.view.dom.lastElementChild;
        last?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      useSkillDiffToastStore.getState().show("New section added");
    } else if (candidate.mode === "inline-rewrite") {
      editor.commands.insertArtifactInline({
        artifactId: auditMeta.artifactId,
        skillId: candidate.skillId,
        skillName: candidate.skillName,
        content: candidate.content,
      });
      useSkillDiffToastStore.getState().show("Selection updated");
    } else {
      editor.commands.setContent({ type: "doc", content: candidate.content });
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        editor.view.dom.firstElementChild?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
      useSkillDiffToastStore.getState().show("Note replaced");
    }
    clearDiffDecorations(editor);
  };

  const reject = () => {
    clearDiffDecorations(editor);
    clear(noteId);
  };

  const cancelRefine = () => {
    if (run.isPending) {
      cancel.mutate({ noteId });
    }
    setRefineMode(false);
    setRefineText("");
  };

  const submitRefine = () => {
    if (!refineText.trim()) return;
    run.mutate(
      {
        noteId,
        skillSlug: candidate.skillId,
        modeOverride: candidate.mode,
        refineInstruction: refineText,
        previousOutput: candidate.rawMarkdown,
        selectionText: candidate.selectionText ?? undefined,
      },
      {
        onSuccess: (result) => {
          stage({
            ...result,
            noteId,
            beforeText:
              result.mode === "inline-rewrite"
                ? candidate.selectionText ?? undefined
                : result.beforeText,
            selectionPoints: candidate.selectionPoints,
          });
          setRefineMode(false);
          setRefineText("");
        },
        onError: (err) => {
          // Skip the error toast for user-initiated cancellations (see
          // use-run-skill.ts for the rationale on matching both shapes).
          if (/cancell?ed|abort/i.test(err.message)) return;
          toast.error(`Couldn't refine ${candidate.skillName} — ${err.message}`);
        },
      },
    );
  };

  // Outer pill chrome is plain CSS so it picks up the same `transition-all
  // duration-200 ease-out` rhythm as the recording dock and sparkle pill —
  // no shared-layout shenanigans, so mounting/unmounting in the dock slot
  // doesn't produce a shrink-and-grow wobble. AnimatePresence inside still
  // morphs accept-row <-> refine-input.
  return (
    <div className={`${PILL_OUTER} pl-3 pr-1 gap-1`}>
      <div className="flex items-center gap-1.5 text-sm font-medium text-white/85 pr-2 mr-1 border-r border-white/15">
        <IconSparkles size={16} className="shrink-0 text-white/80" />
        <span className="max-w-[140px] truncate">{candidate.skillName}</span>
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        {refineMode && run.isPending ? (
          <motion.div
            key="refining"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={INNER_TRANSITION}
            className="flex items-center gap-1"
          >
            <span className="shimmer-text-pill pr-2 text-sm font-medium">
              Refining
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={cancelRefine}
                  className={`${INNER_BTN} w-8 text-white/60`}
                  aria-label="Stop refinement"
                >
                  <IconX size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Stop refining</TooltipContent>
            </Tooltip>
          </motion.div>
        ) : refineMode ? (
          <motion.div
            key="refine"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={INNER_TRANSITION}
            className="flex items-center gap-1"
          >
            <input
              type="text"
              autoFocus
              placeholder="Refine instruction…"
              value={refineText}
              onChange={(e) => setRefineText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRefine();
                if (e.key === "Escape") cancelRefine();
              }}
              className="h-8 w-[240px] bg-transparent text-sm text-white placeholder:text-white/40 outline-none px-2"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={submitRefine}
                  disabled={!refineText.trim()}
                  className={`${INNER_BTN} w-8`}
                  aria-label="Submit refinement"
                >
                  <IconCornerDownLeft size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Submit refinement</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={cancelRefine}
                  className={`${INNER_BTN} w-8 text-white/60`}
                  aria-label="Cancel refinement"
                >
                  <IconX size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Cancel</TooltipContent>
            </Tooltip>
          </motion.div>
        ) : (
          <motion.div
            key="actions"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={INNER_TRANSITION}
            className="flex items-center gap-1"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onAccept}
                  disabled={accept.isPending}
                  className={`${INNER_BTN} gap-1.5 px-3 text-sm font-medium text-emerald-300 hover:text-emerald-200`}
                  aria-label="Accept"
                >
                  <IconCheck size={16} />
                  Accept
                </button>
              </TooltipTrigger>
              <TooltipContent>Accept changes</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setRefineMode(true)}
                  className={`${INNER_BTN} gap-1.5 px-3 text-sm`}
                  aria-label="Refine"
                >
                  <IconWand size={16} />
                  Refine
                </button>
              </TooltipTrigger>
              <TooltipContent>Refine with an instruction</TooltipContent>
            </Tooltip>
            {candidate.mode !== "inline-rewrite" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => switchMode(noteId)}
                    disabled={accept.isPending}
                    className={`${INNER_BTN} w-8`}
                    aria-label={
                      candidate.mode === "append-section"
                        ? "Switch to replace document"
                        : "Switch to append section"
                    }
                  >
                    <IconArrowsLeftRight size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {candidate.mode === "append-section"
                    ? "Switch to Replace"
                    : "Switch to Append"}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={reject}
                  disabled={accept.isPending}
                  className={`${INNER_BTN} w-8 text-white/60`}
                  aria-label="Reject"
                >
                  <IconX size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Reject</TooltipContent>
            </Tooltip>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function restoreInlineSelection(
  editor: Editor,
  candidate: { selectionPoints?: { from: number; to: number } },
): boolean {
  const points = candidate.selectionPoints;
  if (!points) return false;
  const { doc } = editor.state;
  if (
    points.from < 0 ||
    points.to > doc.content.size ||
    points.from > points.to
  ) {
    return false;
  }
  try {
    const sel = TextSelection.create(doc, points.from, points.to);
    editor.view.dispatch(editor.state.tr.setSelection(sel));
    return true;
  } catch {
    return false;
  }
}
