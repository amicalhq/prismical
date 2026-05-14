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
// dark pill, rounded-28, backdrop-blur, ring + soft shadow. The morph bar
// occupies the same horizontal slot, so the dock-area swap reads as a single
// surface morphing in place rather than a new floating widget.
const PILL_OUTER =
  "group h-[42px] bg-black/80 dark:bg-black/70 rounded-[28px] backdrop-blur-md " +
  "ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] " +
  "select-none flex items-center";

const INNER_BTN =
  "flex h-8 shrink-0 items-center justify-center rounded-full cursor-pointer " +
  "text-white/80 transition-colors hover:bg-white/15 hover:text-white " +
  "active:scale-95 disabled:cursor-not-allowed disabled:opacity-60";

// Spring transition consistent with the recording-widget pill morphs.
const SPRING = { type: "spring" as const, stiffness: 320, damping: 30, mass: 0.7 };

export function SkillDiffDockBar({ editor, noteId }: Props) {
  const candidate = useSkillDiffStore((s) => s.candidatesByNote.get(noteId));
  const clear = useSkillDiffStore((s) => s.clear);
  const stage = useSkillDiffStore((s) => s.stage);
  const switchMode = useSkillDiffStore((s) => s.switchMode);
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
      // Leave the candidate staged so the user can retry, but drop the
      // preview decorations + reset the cursor — the failed restore left
      // the inline-rewrite path with the selection moved to the would-be
      // edit point, which is misleading when no edit landed.
      clearDiffDecorations(editor);
      return;
    }

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
    } else if (candidate.mode === "inline-rewrite") {
      editor.commands.insertArtifactInline({
        artifactId: auditMeta.artifactId,
        skillId: candidate.skillId,
        skillName: candidate.skillName,
        content: candidate.content,
      });
    } else {
      editor.commands.setContent({ type: "doc", content: candidate.content });
    }
    clearDiffDecorations(editor);
    clear(noteId);
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
          toast.error(`Couldn't refine ${candidate.skillName} — ${err.message}`);
        },
      },
    );
  };

  // Layout transitions on the outer pill animate the width change between
  // the accept-row (compact) and refine-input (wider) states. The
  // AnimatePresence inside cross-fades the two sets of controls.
  return (
    <motion.div
      layout
      transition={SPRING}
      className={`${PILL_OUTER} pl-3 pr-1 gap-1`}
    >
      <motion.div
        layout="position"
        transition={SPRING}
        className="flex items-center gap-1.5 text-sm font-medium text-white/85 pr-2 mr-1 border-r border-white/15"
      >
        <IconSparkles size={16} className="shrink-0 text-white/80" />
        <span className="max-w-[140px] truncate">{candidate.skillName}</span>
      </motion.div>
      <AnimatePresence mode="wait" initial={false}>
        {refineMode ? (
          <motion.div
            key="refine"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
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
                  disabled={run.isPending || !refineText.trim()}
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
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
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
    </motion.div>
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
