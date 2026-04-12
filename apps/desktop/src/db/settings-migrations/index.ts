import type { AppSettingsData } from "../schema";

export type MigrationFn = (data: unknown) => AppSettingsData;

// Fresh installs start at v1. Future schema changes can add migrations here.
export const CURRENT_SETTINGS_VERSION = 1;

const migrations: Record<number, MigrationFn> = {};

export function migrateSettings(
  data: unknown,
  fromVersion: number,
): AppSettingsData {
  let currentData = data;

  for (
    let version = fromVersion + 1;
    version <= CURRENT_SETTINGS_VERSION;
    version++
  ) {
    const migrationFn = migrations[version];
    if (migrationFn) {
      currentData = migrationFn(currentData);
    }
  }

  return currentData as AppSettingsData;
}
