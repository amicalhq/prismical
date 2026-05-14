import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { toast } from "sonner";
import { useSkillDiffStore } from "./skill-diff-store";
import { api } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { skillDiffPluginKey } from "./diff-plugin";
import {
  buildCandidateTransaction,
  buildDiffDecorations,
} from "./build-decorations";

interface Props {
  editor: Editor;
  noteId: number;
}

export function SkillDiffActionBar({ editor, noteId }: Props) {
  const candidate = useSkillDiffStore((s) => s.candidatesByNote.get(noteId));
  const clear = useSkillDiffStore((s) => s.clear);
  const stage = useSkillDiffStore((s) => s.stage);
  const switchMode = useSkillDiffStore((s) => s.switchMode);
  const run = api.skillRuns.run.useMutation();
  const accept = api.skillRuns.accept.useMutation();
  const cancel = api.skillRuns.cancel.useMutation();

  const [refineMode, setRefineMode] = useState(false);
  const [refineText, setRefineText] = useState("");

  // Track which candidate the editor is currently decorated for so refines
  // re-decorate, but a stable candidate doesn't recompute on every render.
  const decoratedForRef = useRef<SkillDiffCandidateKey | null>(null);

  // Apply / refresh decorations whenever the staged candidate changes.
  useEffect(() => {
    if (!candidate) {
      if (decoratedForRef.current !== null) {
        clearDiffDecorations(editor);
        decoratedForRef.current = null;
      }
      return;
    }

    const key = candidateKey(candidate);
    if (decoratedForRef.current === key) return;

    const tr = buildCandidateTransaction(editor.state, candidate);
    if (!tr) {
      // Couldn't materialize the post-state (stale selection, malformed
      // payload). Surface a warning and clear so the user can re-run.
      toast.error(
        "Couldn't preview this run — the editor state has moved on. Try running the skill again.",
      );
      clear(noteId);
      return;
    }
    const decorations = buildDiffDecorations(
      editor.state.doc,
      tr,
      editor.state.schema,
    );
    editor.view.dispatch(
      editor.state.tr.setMeta(skillDiffPluginKey, { decorations }),
    );
    decoratedForRef.current = key;
  }, [editor, candidate, clear, noteId]);

  // Always clear on unmount so a stale decoration doesn't outlive the bar.
  useEffect(() => {
    return () => clearDiffDecorations(editor);
  }, [editor]);

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

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-lg border bg-popover shadow-lg p-2 flex items-center gap-2">
      <div className="text-xs text-muted-foreground pr-2 border-r">
        ✨ {candidate.skillName}
      </div>
      {refineMode ? (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Refine instruction…"
            value={refineText}
            onChange={(e) => setRefineText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitRefine()}
            autoFocus
          />
          <Button onClick={submitRefine} disabled={run.isPending}>
            Submit
          </Button>
          <Button variant="ghost" onClick={cancelRefine}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setRefineMode(true)}>
            ✦ Refine
          </Button>
          {candidate.mode !== "inline-rewrite" ? (
            <Button
              variant="outline"
              onClick={() => switchMode(noteId)}
              disabled={accept.isPending}
              aria-label={
                candidate.mode === "append-section"
                  ? "Switch to replace document"
                  : "Switch to append section"
              }
            >
              {candidate.mode === "append-section"
                ? "Switch to Replace"
                : "Switch to Append"}
            </Button>
          ) : null}
          <Button onClick={onAccept} disabled={accept.isPending}>
            ✓ Accept
          </Button>
          <Button variant="ghost" onClick={reject} disabled={accept.isPending}>
            ✗ Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function clearDiffDecorations(editor: Editor): void {
  const { state, view } = editor;
  view.dispatch(state.tr.setMeta(skillDiffPluginKey, "clear"));
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

// Stable identity for a staged candidate. We use it to avoid recomputing
// decorations on every render when the candidate hasn't changed.
type SkillDiffCandidateKey = string;
function candidateKey(c: {
  skillId: string;
  mode: string;
  rawMarkdown: string;
}): SkillDiffCandidateKey {
  return `${c.mode}|${c.skillId}|${c.rawMarkdown.length}`;
}
