/**
 * Actionable per-error help for recording failures. When the error key tells
 * us WHAT went wrong (a permission denial, not a generic failure), the dock's
 * banner/pill adds the concrete fix for the current platform next to the
 * generic troubleshooting-docs link.
 */
export function recordingErrorHintKey(
  error: string,
  /** EnvPort platform: "web" on the web app, process.platform on desktop. */
  platform: string
):
  | 'recording.errors.microphoneDeniedHintWeb'
  | 'recording.errors.microphoneDeniedHintDesktop'
  | null {
  if (error === 'recording.errors.microphoneDenied') {
    return platform === 'web'
      ? 'recording.errors.microphoneDeniedHintWeb'
      : 'recording.errors.microphoneDeniedHintDesktop';
  }
  return null;
}
