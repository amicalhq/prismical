import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/trpc/react";
import {
  useSkillDiffStore,
  type SerializedSelectionPoints,
} from "@/renderer/main/components/editor/diff/skill-diff-store";
import type { ArtifactMode } from "@/db/schema";

export interface RunSkillArgs {
  noteId: number;
  skillSlug: string;
  skillName: string; // for error toast
  modeOverride?: ArtifactMode;
  selectionText?: string;
  /** Captured at run-time so accept can restore the range (inline-rewrite). */
  selectionPoints?: SerializedSelectionPoints;
}

export function useRunSkill() {
  const stage = useSkillDiffStore((s) => s.stage);
  const utils = api.useUtils();
  const run = api.skillRuns.run.useMutation();

  const runSkill = useCallback(
    (args: RunSkillArgs) => {
      // Surface in-flight state immediately so consumers polling
      // `getInFlight` (sparkle button, inline popover gate) flip to
      // "running" without waiting for the next interval tick — those
      // queries gate refetching on `data` being truthy, so a fresh
      // invalidation is how we kick them out of the idle no-poll state.
      void utils.skillRuns.getInFlight.invalidate({ noteId: args.noteId });
      run.mutate(
        {
          noteId: args.noteId,
          skillSlug: args.skillSlug,
          modeOverride: args.modeOverride,
          selectionText: args.selectionText,
        },
        {
          onSuccess: (result) => {
            stage({
              ...result,
              noteId: args.noteId,
              // Carry the selection points + the selection text as the "before"
              // diff anchor for inline-rewrite mode. For replace-doc / append-
              // section the server populates beforeText itself (or leaves it
              // undefined for append).
              selectionPoints: args.selectionPoints,
              beforeText:
                args.modeOverride === "inline-rewrite"
                  ? args.selectionText
                  : result.beforeText,
            });
          },
          onError: (err) => {
            toast.error(`Couldn't run ${args.skillName} — ${err.message}`);
          },
          onSettled: () => {
            void utils.skillRuns.getInFlight.invalidate({ noteId: args.noteId });
          },
        },
      );
    },
    [run, stage, utils],
  );

  return { runSkill, isPending: run.isPending };
}
