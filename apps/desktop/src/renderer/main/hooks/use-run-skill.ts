import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/trpc/react";
import { useSkillDiffStore } from "@/renderer/main/components/editor/diff/skill-diff-store";
import type { ArtifactMode } from "@/db/schema";

export interface RunSkillArgs {
  noteId: number;
  skillSlug: string;
  skillName: string; // for error toast
  modeOverride?: ArtifactMode;
  selectionText?: string;
}

export function useRunSkill() {
  const stage = useSkillDiffStore((s) => s.stage);
  const run = api.skillRuns.run.useMutation();

  const runSkill = useCallback(
    (args: RunSkillArgs) => {
      run.mutate(
        {
          noteId: args.noteId,
          skillSlug: args.skillSlug,
          modeOverride: args.modeOverride,
          selectionText: args.selectionText,
        },
        {
          onSuccess: (result) => {
            stage({ ...result, noteId: args.noteId });
          },
          onError: (err) => {
            toast.error(`Couldn't run ${args.skillName} — ${err.message}`);
          },
        },
      );
    },
    [run, stage],
  );

  return { runSkill, isPending: run.isPending };
}
