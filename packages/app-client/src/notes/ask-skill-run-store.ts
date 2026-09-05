import { create } from "zustand";
import type { SkillRunSource } from "./skill-run-activity-store";

// Bridges the Ask composer's slash-command send / the Ask pill's suggested chip to the
// skill run bridge (SkillRunBridge in the dock's skill slot) — same seam as the auto-enhance and
// inline-popover bridges, so the run stages a diff candidate exactly like any other run and shows
// up in the Ask thread + on the collapsed Ask pill via the run feed. Keyed by noteId so a request
// only fires on the note it belongs to.
export interface AskSkillRunRequest {
  noteId: string;
  skillId: string;
  skillName: string;
  /** Extra guidance the user typed after the slash token (sent as the run's instruction). */
  instruction?: string;
  /** The composer's slash lane or the pill's one-click chip. */
  source: Extract<SkillRunSource, "chip" | "composer">;
}

interface AskSkillRunState {
  request: AskSkillRunRequest | null;
  /** Ask the skill dock to run a slash-command skill from the Ask composer. */
  requestAskSkillRun: (req: AskSkillRunRequest) => void;
  /** Consume/drop the pending request (call after the dock kicks off the run). */
  clear: () => void;
}

export const useAskSkillRunStore = create<AskSkillRunState>((set) => ({
  request: null,
  requestAskSkillRun: (request) => set({ request }),
  clear: () => set({ request: null }),
}));
