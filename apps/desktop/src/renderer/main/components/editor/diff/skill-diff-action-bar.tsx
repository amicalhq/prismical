import { useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  INSERT_ARTIFACT_NODE_COMMAND,
  INSERT_ARTIFACT_INLINE_NODE_COMMAND,
} from "@/renderer/main/components/editor/commands/artifact-commands";
import { useSkillDiffStore } from "./skill-diff-store";
import { api } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { computeTextDiff } from "./compute-text-diff";
import type React from "react";

interface Props {
  noteId: number;
}

export function SkillDiffActionBar({ noteId }: Props) {
  const [editor] = useLexicalComposerContext();
  const candidate = useSkillDiffStore((s) => s.candidatesByNote.get(noteId));
  const clear = useSkillDiffStore((s) => s.clear);
  const stage = useSkillDiffStore((s) => s.stage);
  const run = api.skillRuns.run.useMutation();

  const [refineMode, setRefineMode] = useState(false);
  const [refineText, setRefineText] = useState("");

  if (!candidate) return null;

  const accept = () => {
    if (candidate.mode === "append-section") {
      editor.dispatchCommand(INSERT_ARTIFACT_NODE_COMMAND, {
        artifactId: candidate.artifactId,
        skillId: candidate.skillId,
        skillName: candidate.skillName,
        version: candidate.version,
        generatedAt: candidate.generatedAt,
        modelId: candidate.modelId,
        content: candidate.content,
      });
    } else if (candidate.mode === "inline-rewrite") {
      editor.dispatchCommand(INSERT_ARTIFACT_INLINE_NODE_COMMAND, {
        artifactId: candidate.artifactId,
        skillId: candidate.skillId,
        skillName: candidate.skillName,
        content: candidate.content,
      });
    } else {
      // replace-doc: deferred to Plan-4 follow-up.
      editor.update(() => {
        console.warn("replace-doc accept not yet implemented");
      });
    }
    clear(noteId);
  };

  const reject = () => clear(noteId);

  const submitRefine = () => {
    if (!refineText.trim()) return;
    run.mutate(
      {
        noteId,
        skillSlug: candidate.skillId,
        modeOverride: candidate.mode,
        refineInstruction: refineText,
        previousOutput: candidate.rawMarkdown,
      },
      {
        onSuccess: (result) => {
          stage({ ...result, noteId });
          setRefineMode(false);
          setRefineText("");
        },
      },
    );
  };

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 rounded-lg border bg-popover shadow-lg p-3 flex flex-col gap-2 max-w-xl">
      <div className="text-xs text-muted-foreground">
        ✨ {candidate.skillName} · v{candidate.version}
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
          <Button variant="ghost" onClick={() => setRefineMode(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setRefineMode(true)}>
            ✦ Refine
          </Button>
          <Button onClick={accept}>✓ Accept</Button>
          <Button variant="ghost" onClick={reject}>
            ✗ Reject
          </Button>
        </div>
      )}
    </div>
  );
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
