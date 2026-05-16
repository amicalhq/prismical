import { app } from "electron";
import { getPlatformDisplayName } from "./platform";

/**
 * Get the User-Agent string for HTTP requests
 * Format: prismical-desktop/{version} ({platform})
 * Example: prismical-desktop/0.1.3 (macOS)
 *
 * Falls back to a static "live-test" version when Electron's `app` is
 * unavailable (i.e. running under `tsx` from a script — see
 * `scripts/test-providers-live.ts`). The header is for telemetry / vendor
 * attribution, not authentication, so a fallback is safer than crashing.
 */
export function getUserAgent(): string {
  const version =
    typeof app !== "undefined" && typeof app.getVersion === "function"
      ? app.getVersion()
      : "live-test";
  const platform = getPlatformDisplayName();
  return `prismical-desktop/${version} (${platform})`;
}
