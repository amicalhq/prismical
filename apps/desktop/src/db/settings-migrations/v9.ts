import type { AppSettingsData } from "../schema";

// v8 -> v9: add meeting recording widget settings with sane defaults
export function migrateToV9(data: unknown): AppSettingsData {
  const oldData = data as AppSettingsData;
  const existingWidget = oldData.meetingWidget;

  return {
    ...oldData,
    meetingWidget: {
      enabled: existingWidget?.enabled ?? true,
      normalizedY: normalizeWidgetPosition(existingWidget?.normalizedY),
    },
  };
}

function normalizeWidgetPosition(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(1, Math.max(0, value ?? 1));
}
