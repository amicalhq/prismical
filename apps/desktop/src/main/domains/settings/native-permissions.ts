/**
 * Pure native-permission policy. No electron import — the
 * System-Settings deep-links and the system-audio status derivation are
 * table-driven and headless-testable. The capability handlers wrap the electron
 * edge (SystemPermissions + NativeOs) around these.
 */
import type { PermissionKind, PermissionStatus } from '@prismical/desktop-contracts';
import {
  SYSTEM_AUDIO_MIN_MAJOR,
  SYSTEM_AUDIO_MIN_MINOR,
  meetsMinimumVersion,
} from '../recording/permission/policy';

/**
 * The OS privacy-pane deep-link for a permission, or null when the platform has
 * no pane for it (Linux, or Windows system audio where WASAPI needs no grant).
 * Uses the platform-specific System Settings deep links.
 */
export function systemSettingsDeepLink(
  kind: PermissionKind,
  platform: NodeJS.Platform
): string | null {
  if (platform === 'darwin') {
    return kind === 'microphone'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture';
  }
  if (platform === 'win32') {
    // Windows exposes a mic privacy pane; WASAPI loopback needs no separate
    // system-audio privacy grant, so there is no system-audio deep-link.
    return kind === 'microphone' ? 'ms-settings:privacy-microphone' : null;
  }
  return null;
}

/**
 * System-audio "status" for the permission readout. This app has no separate
 * TCC readout for system audio. macOS availability uses the ≥14.2 version
 * gate (the real CoreAudio tap grant is confirmed by the native probe at capture
 * time); Windows WASAPI loopback is usable without a separate prompt.
 */
export function systemAudioStatus(
  platform: NodeJS.Platform,
  systemVersion: string
): PermissionStatus {
  if (platform === 'win32') return 'granted';
  if (platform !== 'darwin') return 'unavailable';
  return meetsMinimumVersion(systemVersion, SYSTEM_AUDIO_MIN_MAJOR, SYSTEM_AUDIO_MIN_MINOR)
    ? 'granted'
    : 'unavailable';
}
