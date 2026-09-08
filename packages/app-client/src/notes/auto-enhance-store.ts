import type { AnalyticsPort } from "@prismical/app-contracts";
import { requestSkillRunTiming } from "./skill-run-timing";
import { create } from "zustand";
import type { SkillRunSource } from "./skill-run-activity-store";

// Bridges the recording dock's "Stop" (in RecordingBottomCluster) and the transcript panel's
// per-recording Enhance wand to the skill run bridge (SkillRunBridge in the dock's skill slot) so
// a recording-scoped Enhance stages a diff candidate exactly like a manual run and shows in the
// Ask thread / on the Ask pill via the run feed. Requests retain their owner context
// and recording identity until the matching note editor can run them.
export interface AutoEnhanceRequest {
  /** Monotonic timestamp of the gesture, retained while the editor is unavailable. */
  requestedAt?: number;
  attemptId?: string;
  noteId: string;
  recordingId: string;
  ownerSessionKey: string;
  ownerOrgId: string;
  /** Automatic (on stop) or the user's explicit wand click. */
  source: Extract<SkillRunSource, "auto-enhance" | "wand">;
}

interface AutoEnhanceState {
  requests: AutoEnhanceRequest[];
  /**
   * The recording whose last recording-scoped skill run FAILED. The transcript panel's post-stop
   * bar auto-dismisses after a few seconds, which would take the Enhance chip — the only retry
   * affordance for that recording — with it. Publishing the failure here lets the bar come back
   * and hold, so a failed Enhance is recoverable without starting a new recording.
   */
  failedRecordingId: string | null;
  /**
   * The recording whose Enhance is PARKED: the server kept answering "transcript still
   * finalizing" until its own release deadline. Not a failure — the transcript work continues on
   * the server — so the bar holds open saying so, and re-fires the run by itself once the
   * recording's finalize phase settles (or on the chip). Distinct from `failedRecordingId` so the
   * bar never shows a parked run as an error.
   */
  waitingRecordingId: string | null;
  /** Ask the skill dock to auto-enhance the just-stopped recording. */
  requestAutoEnhance: (req: AutoEnhanceRequest, analytics?: AnalyticsPort) => void;
  /** Consume/drop the pending request (call after the dock kicks off the run). */
  clear: () => void;
  consume: (recordingId: string) => void;
  /** Record that a recording-scoped run failed, so its Enhance chip is offered again. */
  markFailed: (recordingId: string) => void;
  /** Drop the marker for a recording once it is retried, so a stale failure can't outlive it. */
  clearFailed: (recordingId: string) => void;
  /** Record that a recording-scoped run is parked behind transcript finalization. */
  markWaiting: (recordingId: string) => void;
  clearWaiting: (recordingId: string) => void;
}

export const useAutoEnhanceStore = create<AutoEnhanceState>((set) => ({
  requests: [],
  failedRecordingId: null,
  waitingRecordingId: null,
  // A fresh attempt supersedes any earlier failure or park — otherwise the bar would keep holding
  // open for a recording the user has already retried.
  requestAutoEnhance: (request, analytics) =>
    set((state) => ({
      requests: [
        ...state.requests.filter((item) => item.recordingId !== request.recordingId),
        {
          ...request,
          ...requestSkillRunTiming(analytics, {
            note_id: request.noteId,
            recording_id: request.recordingId,
            skill_id: "skl_enhance",
            source: request.source,
          }),
        },
      ],
      failedRecordingId: null,
      waitingRecordingId: null,
    })),
  clear: () => set({ requests: [] }),
  consume: (recordingId) =>
    set((state) => ({
      requests: state.requests.filter((item) => item.recordingId !== recordingId),
    })),
  markFailed: (recordingId) => set({ failedRecordingId: recordingId, waitingRecordingId: null }),
  clearFailed: (recordingId) =>
    set((state) => (state.failedRecordingId === recordingId ? { failedRecordingId: null } : state)),
  markWaiting: (recordingId) => set({ waitingRecordingId: recordingId, failedRecordingId: null }),
  clearWaiting: (recordingId) =>
    set((state) => (state.waitingRecordingId === recordingId ? { waitingRecordingId: null } : state)),
}));
