import { create } from "zustand";
import type { SkillRunSource } from "./skill-run-activity-store";

// Bridges the recording dock's "Stop" (in RecordingBottomCluster) and the transcript panel's
// per-recording Enhance wand to the skill run bridge (SkillRunBridge in the dock's skill slot) so
// a recording-scoped Enhance stages a diff candidate exactly like a manual run and shows in the
// Ask thread / on the Ask pill via the run feed. Keyed by noteId so a
// request only fires on the note it belongs to. One pending request at a time is enough (a user
// stops one recording).
export interface AutoEnhanceRequest {
  noteId: string;
  recordingId: string;
  /** Automatic (on stop) or the user's explicit wand click. */
  source: Extract<SkillRunSource, "auto-enhance" | "wand">;
}

interface AutoEnhanceState {
  request: AutoEnhanceRequest | null;
  /**
   * The recording whose last recording-scoped skill run FAILED. The transcript panel's post-stop
   * bar auto-dismisses after a few seconds, which would take the Enhance chip — the only retry
   * affordance for that recording — with it. Publishing the failure here lets the bar come back
   * and hold, so a failed Enhance is recoverable without starting a new recording.
   */
  failedRecordingId: string | null;
  /** Ask the skill dock to auto-enhance the just-stopped recording. */
  requestAutoEnhance: (req: AutoEnhanceRequest) => void;
  /** Consume/drop the pending request (call after the dock kicks off the run). */
  clear: () => void;
  /** Record that a recording-scoped run failed, so its Enhance chip is offered again. */
  markFailed: (recordingId: string) => void;
  /** Drop the marker for a recording once it is retried, so a stale failure can't outlive it. */
  clearFailed: (recordingId: string) => void;
}

export const useAutoEnhanceStore = create<AutoEnhanceState>((set) => ({
  request: null,
  failedRecordingId: null,
  // A fresh attempt supersedes any earlier failure — otherwise the bar would keep holding open
  // for a recording the user has already retried.
  requestAutoEnhance: (request) => set({ request, failedRecordingId: null }),
  clear: () => set({ request: null }),
  markFailed: (recordingId) => set({ failedRecordingId: recordingId }),
  clearFailed: (recordingId) =>
    set((state) => (state.failedRecordingId === recordingId ? { failedRecordingId: null } : state)),
}));
