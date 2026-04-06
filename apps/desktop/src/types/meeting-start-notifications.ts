export type KnownMeetingAppCategory = "browser" | "native";

export interface KnownMeetingApp {
  bundleId: string;
  displayName: string;
  category: KnownMeetingAppCategory;
  enabledByDefault: boolean;
  aliases?: string[];
  priority?: number;
}

export interface MicActiveApp {
  bundleId: string;
  pid: number;
  detectedAtMs: number;
  applicationName?: string;
}

export interface MicActivitySnapshotEvent {
  timestampMs: number;
  apps: MicActiveApp[];
}

export interface MeetingStartNotificationPayload {
  id: string;
  bundleId: string;
  displayName: string;
  category: KnownMeetingAppCategory;
  title: string;
  subtitle: string;
  detectedAtMs: number;
  isTest?: boolean;
}

export interface MeetingStartNotificationState {
  detectorState: "idle" | "running" | "error";
  activeNotification: MeetingStartNotificationPayload | null;
  lastError: string | null;
}
