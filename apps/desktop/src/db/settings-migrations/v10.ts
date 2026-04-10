import type { AppSettingsData } from "../schema";

// v9 -> v10: remove obsolete recording mute preference flags
export function migrateToV10(data: unknown): AppSettingsData {
  const oldData = data as AppSettingsData & {
    preferences?: {
      muteSystemAudio?: boolean;
      muteDictationSounds?: boolean;
    };
  };
  const preferences = { ...(oldData.preferences ?? {}) } as Record<
    string,
    unknown
  >;
  delete preferences.muteSystemAudio;
  delete preferences.muteDictationSounds;

  return {
    ...oldData,
    preferences: preferences as AppSettingsData["preferences"],
  };
}
