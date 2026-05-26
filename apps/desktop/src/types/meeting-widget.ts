import type { MeetingRuntimeState } from "./meeting";
import type { MeetingStartNotificationPayload } from "./meeting-start-notifications";

export type MeetingWidgetVisibility = "never" | "while-recording" | "always";
export type MeetingWidgetEdge = "right" | "bottom";

export interface MeetingWidgetState {
  visibility: MeetingWidgetVisibility;
  visible: boolean;
  meetingState: MeetingRuntimeState;
  noteId: number | null;
  meetingDetection: MeetingStartNotificationPayload | null;
  edge: MeetingWidgetEdge;
}
