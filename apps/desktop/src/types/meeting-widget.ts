import type { MeetingRuntimeState } from "./meeting";

export interface MeetingWidgetState {
  enabled: boolean;
  visible: boolean;
  meetingState: MeetingRuntimeState;
  noteId: number | null;
}
