import type { MeetingRuntimeState } from "./meeting";

export type MeetingWidgetVisibility = "never" | "while-recording" | "always";

export interface MeetingWidgetState {
  visibility: MeetingWidgetVisibility;
  visible: boolean;
  meetingState: MeetingRuntimeState;
  noteId: number | null;
}
