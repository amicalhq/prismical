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
      // Don't pre-invalidate `getInFlight` here — that races: the refetch
      // can complete BEFORE the mutation reaches the server, leaving the
      // query stuck at null while the run is in flight. Instead, consumers
      // gate the Stop button on either `isPending` (the initiator gets an
      // instant signal) OR the polled `getInFlight` value (cross-component
      // consumers see the server-side registry once polling picks it up).
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
            // Cancellation is user-initiated, not a failure — show no toast.
            // The server throws SkillCancelledError("Skill run was cancelled"),
            // and an abort that bypassed our wrapper would surface as a plain
            // AbortError; covering both keeps this resilient to wire-format
            // changes.
            if (/cancell?ed|abort/i.test(err.message)) return;
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
