import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { toast } from "sonner";
import { useSkillDiffStore } from "./skill-diff-store";
import { api } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { computeTextDiff } from "./compute-text-diff";
import type React from "react";

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

  if (!candidate) return null;

  const onAccept = async () => {
    // Inline-rewrite needs the original range restored BEFORE we write the
    // audit row — if the underlying positions are gone, surface an error
    // and skip the DB write entirely.
    if (candidate.mode === "inline-rewrite") {
      const restored = restoreInlineSelection(editor, candidate);
      if (!restored) {
        toast.error(
          "The selection where this rewrite was run no longer exists. Re-highlight and try again.",
        );
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
      // replace-doc: swap the entire doc content for the candidate's blocks.
      editor.commands.setContent({ type: "doc", content: candidate.content });
    }
    clear(noteId);
  };

  const reject = () => clear(noteId);

  const cancelRefine = () => {
    // If a refine call is mid-flight, abort it via the server so the
    // in-flight registry entry is freed and the eventual response doesn't
    // re-stage a candidate the user thought they cancelled.
    if (run.isPending) {
      cancel.mutate({ noteId });
    }
    setRefineMode(false);
    setRefineText("");
  };

  const submitRefine = () => {
    if (!refineText.trim()) return;
    // Carry the original selectionText (model context) AND selectionPoints
    // (accept-time selection restore) through refine — otherwise refined
    // inline rewrites lose their anchor and can't be accepted.
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
            // Server populates beforeText for replace-doc; for inline-rewrite
            // we keep the original selection text as the diff anchor.
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
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 rounded-lg border bg-popover shadow-lg p-3 flex flex-col gap-2 max-w-xl">
      <div className="text-xs text-muted-foreground">
        ✨ {candidate.skillName}
      </div>
      <div className="rounded-md bg-card p-3 max-h-64 overflow-y-auto text-sm whitespace-pre-wrap">
        {candidate.mode === "replace-doc" && candidate.beforeText ? (
          renderInlineDiff(candidate.beforeText, candidate.rawMarkdown)
        ) : (
          <span style={{ color: "var(--diff-insert)" }}>
            {candidate.rawMarkdown}
          </span>
        )}
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

// Restore the original ProseMirror range selection captured when this
// candidate was staged. Returns true on success, false if the positions
// no longer point at valid nodes (in which case the caller should reject
// the accept).
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

function renderInlineDiff(before: string, after: string): React.ReactNode {
  const spans = computeTextDiff(before, after);
  return spans.map((span, i) => {
    if (span.kind === "equal") return <span key={i}>{span.text}</span>;
    if (span.kind === "insert")
      return (
        <span key={i} className="prismical-diff-insert">
          {span.text}
        </span>
      );
    return (
      <span key={i} className="prismical-diff-delete">
        {span.text}
      </span>
    );
  });
}
