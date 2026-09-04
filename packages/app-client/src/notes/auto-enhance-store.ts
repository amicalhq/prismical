import { create } from "zustand";

// Bridges the recording dock's "Stop" (in RecordingBottomCluster) to the skill dock's run instance
// (in SkillSparkleButton) so an auto-enhance shows the dock's own "Generating" + Stop and stages a
// diff candidate exactly like a manual run. Keyed by noteId so a request only fires on
// the note it belongs to. One pending request at a time is enough (a user stops one recording).
export interface AutoEnhanceRequest {
  noteId: string;
  recordingId: string;
}

interface AutoEnhanceState {
  request: AutoEnhanceRequest | null;
  /** Ask the skill dock to auto-enhance the just-stopped recording. */
  requestAutoEnhance: (req: AutoEnhanceRequest) => void;
  /** Consume/drop the pending request (call after the dock kicks off the run). */
  clear: () => void;
}

export const useAutoEnhanceStore = create<AutoEnhanceState>((set) => ({
  request: null,
  requestAutoEnhance: (request) => set({ request }),
  clear: () => set({ request: null }),
}));
