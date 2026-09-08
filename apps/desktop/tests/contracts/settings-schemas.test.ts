/**
 * Device-settings contract schemas. The desktop-contracts
 * zod mirror of app-contracts' renderer-facing DeviceSettings: strip-on-read,
 * strict-on-patch, closed enums, and the two DEFAULT constants pinned equal.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_SETTINGS,
  deviceSettingsSchema,
  parseDeviceSettings,
  parseDeviceSettingsPatch,
} from '@prismical/desktop-contracts';
import { DEFAULT_DEVICE_SETTINGS as APP_DEFAULT_DEVICE_SETTINGS } from '@prismical/app-contracts';

const valid = {
  launchAtLogin: false,
  dockVisible: true,
  widgetVisibility: 'always',
  widgetNormalizedY: 0.5,
  updateChannel: 'stable',
  language: '',
  // Dock settings.
  dockAnchors: { '1': { nx: 0.5, ny: 0.25 } },
  dockDisplayId: '1',
  floatNoteBounds: { '1': { nx: 0, ny: 0, nw: 0.3, nh: 0.6 } },
  meetingNotifications: true,
  dockHotkey: 'Alt+Shift+N',
  autoExpandOnRecording: false,
  dockContentProtection: false,
  telemetryOptOut: false,
  // Transcription engine.
  transcription: { engine: 'cloud', modelId: null, byokBaseUrl: null, byokModel: null },
  ai: { provider: 'openai', model: null, baseUrl: null },
};

describe('device-settings schemas', () => {
  it('validates onboarding progress and bounds discovery details', () => {
    const onboarding = { step: 'permissions', discoverySource: 'github', discoveryDetails: '' };
    expect(parseDeviceSettingsPatch({ onboarding }).success).toBe(true);
    expect(
      parseDeviceSettingsPatch({ onboarding: { ...onboarding, step: 'invalid' } }).success
    ).toBe(false);
    expect(
      parseDeviceSettingsPatch({ onboarding: { ...onboarding, discoverySource: 'invalid' } })
        .success
    ).toBe(false);
    expect(
      parseDeviceSettingsPatch({ onboarding: { ...onboarding, discoveryDetails: 'x'.repeat(201) } })
        .success
    ).toBe(false);
    expect(
      parseDeviceSettingsPatch({ onboarding: { ...onboarding, token: 'secret' } }).success
    ).toBe(false);
  });
  it('accepts a full valid DeviceSettings and the default constant', () => {
    expect(parseDeviceSettings(valid).success).toBe(true);
    expect(deviceSettingsSchema.safeParse(DEFAULT_DEVICE_SETTINGS).success).toBe(true);
  });

  it('the desktop-contracts default mirrors the app-contracts canonical default', () => {
    // Pins the independent mirror — a drift between the two packages fails here.
    expect(DEFAULT_DEVICE_SETTINGS).toEqual(APP_DEFAULT_DEVICE_SETTINGS);
  });

  it('deviceSettingsSchema strips unknown keys (incl. token-shaped) rather than failing', () => {
    const parsed = parseDeviceSettings({ ...valid, token: 'SENTINEL', idToken: 'SENTINEL' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).token).toBeUndefined();
      expect((parsed.data as Record<string, unknown>).idToken).toBeUndefined();
      expect(JSON.stringify(parsed.data)).not.toContain('SENTINEL');
    }
  });

  it('enum + type validation is closed (widgetVisibility, updateChannel, field types)', () => {
    expect(parseDeviceSettings({ ...valid, widgetVisibility: 'never' }).success).toBe(true);
    expect(parseDeviceSettings({ ...valid, widgetVisibility: 'sometimes' }).success).toBe(false);
    expect(parseDeviceSettings({ ...valid, updateChannel: 'beta' }).success).toBe(true);
    expect(parseDeviceSettings({ ...valid, updateChannel: 'nightly' }).success).toBe(false);
    expect(parseDeviceSettings({ ...valid, language: 'de' }).success).toBe(true);
    expect(parseDeviceSettings({ ...valid, language: 'zh-TW' }).success).toBe(true);
    expect(parseDeviceSettings({ ...valid, language: 'fr-CA' }).success).toBe(false);
    expect(parseDeviceSettings({ ...valid, launchAtLogin: 'yes' }).success).toBe(false);
    expect(parseDeviceSettings({ ...valid, widgetNormalizedY: '0.5' }).success).toBe(false);
    // A missing required field fails.
    expect(
      parseDeviceSettings({
        launchAtLogin: false,
        dockVisible: true,
        widgetVisibility: 'always',
        widgetNormalizedY: 0.5,
        updateChannel: 'stable',
      }).success
    ).toBe(false);
  });

  it('deviceSettingsPatchSchema is strict + all-optional, with the enums still enforced', () => {
    expect(parseDeviceSettingsPatch({}).success).toBe(true);
    expect(parseDeviceSettingsPatch({ dockVisible: false }).success).toBe(true);
    expect(parseDeviceSettingsPatch(valid).success).toBe(true);
    // Strict: an unknown key rejects the whole patch.
    expect(parseDeviceSettingsPatch({ dockVisible: false, extra: true }).success).toBe(false);
    expect(parseDeviceSettingsPatch({ token: 'SENTINEL' }).success).toBe(false);
    // Enum still enforced on any provided field.
    expect(parseDeviceSettingsPatch({ widgetVisibility: 'never' }).success).toBe(true);
    expect(parseDeviceSettingsPatch({ widgetVisibility: 'sometimes' }).success).toBe(false);
    expect(parseDeviceSettingsPatch({ language: '' }).success).toBe(true);
    expect(parseDeviceSettingsPatch({ language: 'ja' }).success).toBe(true);
    expect(parseDeviceSettingsPatch({ language: 'fr' }).success).toBe(false);
    expect(parseDeviceSettingsPatch({ widgetNormalizedY: 0.9 }).success).toBe(true);
    expect(parseDeviceSettingsPatch({ widgetNormalizedY: 'x' }).success).toBe(false);
  });

  // --- Dock settings ---------------------------------------------------------

  it('dock record fields validate their per-display values (finite numbers only)', () => {
    expect(parseDeviceSettings({ ...valid, dockAnchors: {} }).success).toBe(true);
    expect(
      parseDeviceSettings({ ...valid, dockAnchors: { '1': { nx: 0.5 } } }).success // ny missing
    ).toBe(false);
    expect(
      parseDeviceSettings({ ...valid, dockAnchors: { '1': { nx: Number.NaN, ny: 0 } } }).success
    ).toBe(false);
    expect(
      parseDeviceSettings({
        ...valid,
        floatNoteBounds: { '1': { nx: 0, ny: 0, nw: Number.POSITIVE_INFINITY, nh: 0.5 } },
      }).success
    ).toBe(false);
    // A stray key inside a record VALUE is stripped, not fatal (membrane stance).
    const parsed = parseDeviceSettings({
      ...valid,
      dockAnchors: { '1': { nx: 0.5, ny: 0.25, token: 'SENTINEL' } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(JSON.stringify(parsed.data)).not.toContain('SENTINEL');
  });

  it('dockDisplayId is a nullable string; dock booleans + hotkey are typed', () => {
    expect(parseDeviceSettings({ ...valid, dockDisplayId: null }).success).toBe(true);
    expect(parseDeviceSettings({ ...valid, dockDisplayId: 42 }).success).toBe(false);
    expect(parseDeviceSettings({ ...valid, meetingNotifications: 'yes' }).success).toBe(false);
    expect(parseDeviceSettings({ ...valid, dockHotkey: '' }).success).toBe(true); // '' = disabled
    expect(parseDeviceSettingsPatch({ dockDisplayId: null }).success).toBe(true);
    expect(parseDeviceSettingsPatch({ dockAnchors: { '2': { nx: 1, ny: 0 } } }).success).toBe(true);
    expect(parseDeviceSettingsPatch({ dockAnchors: { '2': { nx: 'x', ny: 0 } } }).success).toBe(
      false
    );
  });
});
