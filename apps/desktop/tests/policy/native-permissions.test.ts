/**
 * Pure native-permission policy tests: the System Settings
 * deep-link map + the system-audio version-gate status derivation. Electron-free.
 */
import { describe, expect, it } from 'vitest';
import {
  systemAudioStatus,
  systemSettingsDeepLink,
} from '../../src/main/domains/settings/native-permissions';

describe('native-permissions', () => {
  describe('systemSettingsDeepLink', () => {
    it('darwin: mic + system-audio privacy panes', () => {
      expect(systemSettingsDeepLink('microphone', 'darwin')).toBe(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      );
      expect(systemSettingsDeepLink('system-audio', 'darwin')).toBe(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture'
      );
    });

    it('win32: a mic pane only — WASAPI loopback needs no system-audio pane', () => {
      expect(systemSettingsDeepLink('microphone', 'win32')).toBe('ms-settings:privacy-microphone');
      expect(systemSettingsDeepLink('system-audio', 'win32')).toBeNull();
    });

    it('linux/other: no pane', () => {
      expect(systemSettingsDeepLink('microphone', 'linux')).toBeNull();
      expect(systemSettingsDeepLink('system-audio', 'linux')).toBeNull();
    });
  });

  describe('systemAudioStatus', () => {
    it('darwin ≥14.2 → granted (usable)', () => {
      expect(systemAudioStatus('darwin', '14.2.0')).toBe('granted');
      expect(systemAudioStatus('darwin', '15.1.0')).toBe('granted');
    });

    it('darwin <14.2 → unavailable', () => {
      expect(systemAudioStatus('darwin', '14.1.0')).toBe('unavailable');
      expect(systemAudioStatus('darwin', '13.6.0')).toBe('unavailable');
    });

    it('Windows WASAPI loopback → granted; unsupported Linux → unavailable', () => {
      expect(systemAudioStatus('win32', '14.4.0')).toBe('granted');
      expect(systemAudioStatus('linux', '99.0.0')).toBe('unavailable');
    });
  });
});
