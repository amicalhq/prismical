import { create } from "zustand";
import type { SelectionAnchors } from "./diff/selection-anchors";

// Bridges the inline skill popover (in the note body) to the skill dock's run instance (in
// SkillSparkleButton) so an inline-rewrite run shows the dock's own "Generating" + Stop and stages
// a diff candidate exactly like a manual run — same pattern as useAutoEnhanceStore.
// Keyed by noteId so a request only fires on the note it belongs to.
export interface InlineRunRequest {
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
  requestInlineRun: (req: InlineRunRequest) => void;
  /** Consume/drop the pending request (call after the dock kicks off the run). */
  clear: () => void;
}

export const useInlineRunStore = create<InlineRunState>((set) => ({
  request: null,
  requestInlineRun: (request) => set({ request }),
  clear: () => set({ request: null }),
}));
