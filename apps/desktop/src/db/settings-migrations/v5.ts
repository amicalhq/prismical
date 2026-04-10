import type { AppSettingsData } from "../schema";

// v4 -> v5: normalize preferences section shape
export function migrateToV5(data: unknown): AppSettingsData {
  const oldData = data as AppSettingsData;
  return {
    ...oldData,
    preferences: oldData.preferences ?? {},
  };
}
