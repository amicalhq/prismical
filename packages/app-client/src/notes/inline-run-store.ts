import type { AnalyticsPort } from "@prismical/app-contracts";
import { requestSkillRunTiming } from "./skill-run-timing";
import { create } from "zustand";
import type { SelectionAnchors } from "./diff/selection-anchors";

// Bridges the inline skill popover (in the note body) to the skill run bridge (SkillRunBridge in
// the dock's skill slot) so an inline-rewrite run stages a diff candidate exactly like a manual run
// and shows on the Ask pill / in the Ask thread via the run feed — same pattern as
// useAutoEnhanceStore.
// Keyed by noteId so a request only fires on the note it belongs to.
export interface InlineRunRequest {
  /** Monotonic timestamp of the gesture, retained while the editor is unavailable. */
  requestedAt?: number;
  attemptId?: string;
  noteId: string;
  skillId: string;
  skillName: string;
  /** The highlighted text (model input). */
  selectionText: string;
  /** Yjs relative anchors of the range accept will replace. */
  selectionAnchors: SelectionAnchors;
  /** Live editor markdown (the server snapshot may not contain just-typed selection text). */
  noteMarkdown?: string;
}

interface InlineRunState {
  request: InlineRunRequest | null;
  /** Ask the skill dock to run an inline rewrite on the captured selection. */
  requestInlineRun: (req: InlineRunRequest, analytics?: AnalyticsPort) => void;
  /** Consume/drop the pending request (call after the dock kicks off the run). */
  clear: () => void;
}

export const useInlineRunStore = create<InlineRunState>((set) => ({
  request: null,
  requestInlineRun: (request, analytics) =>
    set({
      request: {
        ...request,
        ...requestSkillRunTiming(analytics, {
          note_id: request.noteId,
          skill_id: request.skillId,
          source: "inline",
        }),
      },
    }),
  clear: () => set({ request: null }),
}));
