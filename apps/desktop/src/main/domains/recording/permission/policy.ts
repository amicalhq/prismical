/**
 * Pure permission policy. No electron/os import — the
 * version gate is table-driven unit-testable. The system-audio process tap
 * (CATapDescription / AudioHardwareCreateProcessTap) is `#available(macOS 14.2)`
 * in the native helper — below that the binary throws
 * `unsupportedSystemAudioOSVersion`, so we must NOT spawn `system`/`dual` there
 * This is the deterministic, headless-testable half of the gate; the
 * on-device TCC/tap grant is confirmed by the native probe at capture time.
 */

/** macOS system-audio CoreAudio process-tap floor. */
export const SYSTEM_AUDIO_MIN_MAJOR = 14;
export const SYSTEM_AUDIO_MIN_MINOR = 2;

/**
 * `version >= minMajor.minMinor`, comparing the leading `major.minor` of a
 * dotted OS version string (e.g. "14.2.1"). Fails CLOSED — an unparseable
 * version returns false, so system audio degrades to mic-only rather than
 * spawning a binary that will throw.
 */
export function meetsMinimumVersion(
  version: string,
  minMajor: number,
  minMinor: number
): boolean {
  const parts = version.split('.');
  const major = Number.parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(major)) return false;
  if (major !== minMajor) return major > minMajor;
  const minor = Number.parseInt(parts[1] ?? '0', 10);
  return (Number.isFinite(minor) ? minor : 0) >= minMinor;
}
