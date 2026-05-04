import { app } from "electron";
import { EventEmitter } from "events";
import {
  getSettingsSection,
  updateSettingsSection,
  getAppSettings,
  updateAppSettings,
} from "../db/app-settings";
import type { AppSettingsData, ModelSelection } from "../db/schema";

export type DefaultUseCase = "transcription" | "formatting" | "embedding";
import {
  validateShortcutComprehensive,
  type ShortcutType,
  type ValidationResult,
} from "../utils/shortcut-validation";

/**
 * Database-backed settings service with typed configuration
 */
export interface ShortcutsConfig {
  pushToTalk: number[];
  toggleRecording: number[];
  pasteLastTranscript: number[];
  newNote: number[];
  openApp: number[];
}

export interface AppPreferences {
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  showInDock: boolean;
  autoTranscribeOnNewNote: boolean;
}

export interface MeetingNotificationSettings {
  enabled: boolean;
  impromptuEnabled: boolean;
  detectionDelayMs: number;
  cooldownMs: number;
  blockedBundleIds: string[];
}

export type MeetingWidgetVisibility = "never" | "while-recording" | "always";

export interface MeetingWidgetSettings {
  visibility: MeetingWidgetVisibility;
  normalizedY: number;
}

export class SettingsService extends EventEmitter {
  constructor() {
    super();
  }

  /**
   * Get all app settings
   */
  async getAllSettings(): Promise<AppSettingsData> {
    return await getAppSettings();
  }

  /**
   * Update multiple settings at once
   */
  async updateSettings(
    settings: Partial<AppSettingsData>,
  ): Promise<AppSettingsData> {
    return await updateAppSettings(settings);
  }

  /**
   * Get UI settings
   */
  async getUISettings(): Promise<NonNullable<AppSettingsData["ui"]>> {
    return (
      (await getSettingsSection("ui")) ?? {
        theme: "system",
      }
    );
  }

  /**
   * Update UI settings
   */
  async setUISettings(
    uiSettings: NonNullable<AppSettingsData["ui"]>,
  ): Promise<void> {
    await updateSettingsSection("ui", uiSettings);

    // Emit event if theme changed (AppManager will handle window updates)
    if (uiSettings?.theme !== undefined) {
      this.emit("theme-changed", { theme: uiSettings.theme });
    }
  }

  /**
   * Get transcription settings
   */
  async getTranscriptionSettings(): Promise<AppSettingsData["transcription"]> {
    return await getSettingsSection("transcription");
  }

  /**
   * Update transcription settings
   */
  async setTranscriptionSettings(
    transcriptionSettings: AppSettingsData["transcription"],
  ): Promise<void> {
    await updateSettingsSection("transcription", transcriptionSettings);
  }

  /**
   * Get recording settings
   */
  async getRecordingSettings(): Promise<AppSettingsData["recording"]> {
    return await getSettingsSection("recording");
  }

  /**
   * Update recording settings
   */
  async setRecordingSettings(
    recordingSettings: AppSettingsData["recording"],
  ): Promise<void> {
    await updateSettingsSection("recording", recordingSettings);
  }

  /**
   * Get meeting recording widget settings.
   */
  async getMeetingWidgetSettings(): Promise<MeetingWidgetSettings> {
    const meetingWidget = await getSettingsSection("meetingWidget");

    return {
      visibility: meetingWidget?.visibility ?? "always",
      normalizedY: clampNormalizedY(meetingWidget?.normalizedY ?? 0.5),
    };
  }

  /**
   * Update meeting recording widget settings.
   */
  async setMeetingWidgetSettings(
    meetingWidgetSettings: Partial<MeetingWidgetSettings>,
  ): Promise<void> {
    const current = await this.getMeetingWidgetSettings();
    const next = {
      ...current,
      ...meetingWidgetSettings,
      normalizedY: clampNormalizedY(
        meetingWidgetSettings.normalizedY ?? current.normalizedY,
      ),
    };

    await updateSettingsSection("meetingWidget", next);
    this.emit("meeting-widget-settings-changed", next);
  }

  /**
   * Get dictation settings
   */
  async getDictationSettings(): Promise<
    NonNullable<AppSettingsData["dictation"]>
  > {
    const dictationSettings = await getSettingsSection("dictation");
    if (!dictationSettings) {
      throw new Error("Dictation settings are missing");
    }
    return dictationSettings;
  }

  /**
   * Update dictation settings
   */
  async setDictationSettings(
    dictationSettings: AppSettingsData["dictation"],
  ): Promise<void> {
    await updateSettingsSection("dictation", dictationSettings);
  }

  /**
   * Get shortcuts configuration
   * Defaults are handled by app-settings.ts during initialization/migration
   */
  async getShortcuts(): Promise<ShortcutsConfig> {
    const shortcuts = await getSettingsSection("shortcuts");
    return {
      pushToTalk: shortcuts?.pushToTalk ?? [],
      toggleRecording: shortcuts?.toggleRecording ?? [],
      pasteLastTranscript: shortcuts?.pasteLastTranscript ?? [],
      newNote: shortcuts?.newNote ?? [],
      openApp: shortcuts?.openApp ?? [],
    };
  }

  /**
   * Validate and persist a single shortcut without going through ShortcutManager.
   * Used by shortcuts that don't need the native key-capture bridge (e.g. openApp,
   * which is registered via Electron's globalShortcut).
   */
  async setShortcutStandalone(
    type: ShortcutType,
    keys: number[],
  ): Promise<ValidationResult> {
    const current = await this.getShortcuts();
    const result = validateShortcutComprehensive({
      candidateShortcut: keys,
      candidateType: type,
      shortcutsByType: current,
      platform: process.platform,
    });
    if (!result.valid) return result;

    await this.setShortcuts({ ...current, [type]: keys });
    return result;
  }

  /**
   * Update shortcuts configuration
   */
  async setShortcuts(shortcuts: ShortcutsConfig): Promise<void> {
    // Store empty arrays as undefined to clear shortcuts
    const dataToStore = {
      pushToTalk: shortcuts.pushToTalk?.length
        ? shortcuts.pushToTalk
        : undefined,
      toggleRecording: shortcuts.toggleRecording?.length
        ? shortcuts.toggleRecording
        : undefined,
      pasteLastTranscript: shortcuts.pasteLastTranscript?.length
        ? shortcuts.pasteLastTranscript
        : undefined,
      newNote: shortcuts.newNote?.length ? shortcuts.newNote : undefined,
      openApp: shortcuts.openApp?.length ? shortcuts.openApp : undefined,
    };
    await updateSettingsSection("shortcuts", dataToStore);
  }

  /**
   * Get all model defaults at once.
   */
  async getModelDefaults(): Promise<AppSettingsData["modelDefaults"]> {
    return await getSettingsSection("modelDefaults");
  }

  /**
   * Get the default model selection for a use case.
   */
  async getDefault(
    useCase: DefaultUseCase,
  ): Promise<ModelSelection | undefined> {
    const defaults = await this.getModelDefaults();
    return defaults?.[useCase];
  }

  /**
   * Set the default model selection for a use case.
   */
  async setDefault(
    useCase: DefaultUseCase,
    selection: ModelSelection,
  ): Promise<void> {
    const current = await this.getModelDefaults();
    await updateSettingsSection("modelDefaults", {
      ...current,
      [useCase]: selection,
    });
  }

  /**
   * Clear the default selection for a use case (the use case will fall back
   * to the pipeline's own preferred-order logic).
   */
  async clearDefault(useCase: DefaultUseCase): Promise<void> {
    const current = await this.getModelDefaults();
    if (!current?.[useCase]) return;

    const next = { ...current };
    delete next[useCase];

    await updateSettingsSection("modelDefaults", next);
  }

  /**
   * Clear any default selection that points at a now-deleted instance.
   * Called by the instances tRPC router when a row is removed.
   */
  async clearDefaultsForInstance(instanceId: string): Promise<void> {
    const current = await this.getModelDefaults();
    if (!current) return;

    const next = { ...current };
    let changed = false;
    for (const useCase of Object.keys(next) as DefaultUseCase[]) {
      if (next[useCase]?.instanceId === instanceId) {
        delete next[useCase];
        changed = true;
      }
    }

    if (!changed) return;

    await updateSettingsSection("modelDefaults", next);
  }

  /**
   * Get app preferences (launch at login, minimize to tray, etc.)
   */
  async getPreferences(): Promise<AppPreferences> {
    const preferences = await getSettingsSection("preferences");
    return {
      launchAtLogin: preferences?.launchAtLogin ?? true,
      minimizeToTray: preferences?.minimizeToTray ?? true,
      showInDock: preferences?.showInDock ?? true,
      autoTranscribeOnNewNote: preferences?.autoTranscribeOnNewNote ?? false,
    };
  }

  /**
   * Set app preferences and handle side effects
   */
  async setPreferences(preferences: Partial<AppPreferences>): Promise<void> {
    const currentPreferences = await this.getPreferences();
    const newPreferences = { ...currentPreferences, ...preferences };

    // Save to database
    await updateSettingsSection("preferences", newPreferences);

    // Handle launch at login change
    if (
      preferences.launchAtLogin !== undefined &&
      preferences.launchAtLogin !== currentPreferences.launchAtLogin
    ) {
      this.syncAutoLaunch();
    }

    // Emit event for listeners (AppManager will handle window updates)
    this.emit("preferences-changed", {
      changes: preferences,
      showInDockChanged: preferences.showInDock !== undefined,
    });
  }

  /**
   * Get meeting notification settings used by impromptu meeting detection.
   */
  async getMeetingNotificationSettings(): Promise<MeetingNotificationSettings> {
    const meetingNotifications = await getSettingsSection(
      "meetingNotifications",
    );

    return {
      enabled: meetingNotifications?.enabled ?? true,
      impromptuEnabled: meetingNotifications?.impromptuEnabled ?? true,
      detectionDelayMs: meetingNotifications?.detectionDelayMs ?? 4000,
      cooldownMs: meetingNotifications?.cooldownMs ?? 300000,
      blockedBundleIds: meetingNotifications?.blockedBundleIds ?? [],
    };
  }

  /**
   * Update meeting notification settings.
   */
  async setMeetingNotificationSettings(
    meetingNotificationSettings: Partial<MeetingNotificationSettings>,
  ): Promise<void> {
    const current = await this.getMeetingNotificationSettings();
    const next = {
      ...current,
      ...meetingNotificationSettings,
    };

    await updateSettingsSection("meetingNotifications", next);
  }

  /**
   * Sync the auto-launch setting with the OS
   * This ensures the OS setting matches our stored preference
   */
  syncAutoLaunch(): void {
    // Get the current preference asynchronously and apply it
    this.getPreferences().then((preferences) => {
      app.setLoginItemSettings({
        openAtLogin: preferences.launchAtLogin,
        openAsHidden: false,
      });
    });
  }

  /**
   * Sync the dock visibility setting with macOS
   * This ensures the dock visibility matches our stored preference
   */
  syncDockVisibility(): void {
    // Only applicable on macOS where app.dock exists
    if (!app.dock) {
      return;
    }

    // Get the current preference asynchronously and apply it
    this.getPreferences().then((preferences) => {
      if (preferences.showInDock) {
        app.dock?.show();
      } else {
        app.dock?.hide();
      }
    });
  }

  /**
   * Get update channel
   */
  async getUpdateChannel(): Promise<"stable" | "beta"> {
    const settings = await getAppSettings();
    return settings.updateChannel ?? "stable";
  }

  /**
   * Set update channel
   */
  async setUpdateChannel(channel: "stable" | "beta"): Promise<void> {
    await updateAppSettings({ updateChannel: channel });
    this.emit("update-channel-changed", channel);
  }

  /**
   * Get telemetry settings
   */
  async getTelemetrySettings(): Promise<AppSettingsData["telemetry"]> {
    const telemetry = await getSettingsSection("telemetry");
    return telemetry ?? { enabled: true }; // Default to enabled
  }

  /**
   * Update telemetry settings
   */
  async setTelemetrySettings(
    telemetrySettings: AppSettingsData["telemetry"],
  ): Promise<void> {
    await updateSettingsSection("telemetry", telemetrySettings);
  }

  /**
   * Get feature flags cache
   */
  async getFeatureFlags(): Promise<AppSettingsData["featureFlags"]> {
    return await getSettingsSection("featureFlags");
  }

  /**
   * Update feature flags cache
   */
  async setFeatureFlags(
    featureFlags: AppSettingsData["featureFlags"],
  ): Promise<void> {
    await updateSettingsSection("featureFlags", featureFlags);
  }
}

function clampNormalizedY(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(1, Math.max(0, value));
}
