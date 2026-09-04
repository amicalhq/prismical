/**
 * Desktop PostHog — the renderer's posthog-js singleton,
 * mirroring the browser client's analytics config (session replay ON, the same
 * `.ph-mask-content` masks, identified-only profiles, autocapture). Config comes
 * from main's env descriptor (key/host/deviceId/platform), NOT window.location.
 * Encapsulates posthog-js so the rest of the renderer only touches the
 * AnalyticsPort + the identity wrappers below.
 */
// posthog-js's default entry lazy-loads the rrweb session-replay recorder + the
// exception-autocapture module as remote <script> tags, which the packaged
// renderer CSP (`script-src 'self'`) blocks — replay would silently never start.
// The renderer vite build ALIASES posthog-js to its inline (no-external) build so
// the recorder is bundled: script-src stays locked AND there's no dependency on
// the reverse proxy forwarding /static/. Kept as a standard import here so tsc
// uses the normal posthog-js types (see vite.renderer.config.mts).
import posthog from "posthog-js";
import type { AnalyticsPort } from "@prismical/app-contracts";

/** UI host for deep-links back to the PostHog app (matches web). */
const POSTHOG_UI_HOST = "https://us.posthog.com";

let ready = false;
export const isPostHogReady = (): boolean => ready;

/** darwin→macos, win32→windows — the platform super-property (matches main). */
const platformTag = (platform: string): string =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;

const superPropertiesFor = (platform: string): Record<string, string> => ({
  platform: platformTag(platform),
});

export interface DesktopPostHogConfig {
  readonly key: string;
  readonly host: string;
  readonly platform: string;
  /** The app mode selects the telemetry policy. */
  readonly appMode: "cloud" | "local";
}

let initialized = false;
let initializedPlatform: string | null = null;

/**
 * Initialise posthog-js once with main's descriptor. The config BASELINE keys
 * on the app mode (never init before the mode is known):
 *  - cloud: service telemetry under the ToS — web-parity config, session
 *    replay on.
 *  - local: privacy-preserving renderer baseline — opted out by default,
 *    autocapture off, replay off, memory-only persistence. (Unreachable until
 *    local mode is selected.)
 */
export function initDesktopPostHog(config: DesktopPostHogConfig): void {
  if (initialized) return;
  initialized = true;
  initializedPlatform = config.platform;
  const local = config.appMode === "local";
  posthog.init(config.key, {
    api_host: config.host,
    ui_host: POSTHOG_UI_HOST,
    // Only create person profiles for logged-in users (matches web).
    person_profiles: "identified_only",
    capture_pageview: false, // desktop has no pageviews yet (hash routes)
    capture_pageleave: !local,
    autocapture: !local, // product analytics: clicks / form interactions (web parity)
    capture_exceptions: true, // renderer crash/exception autocapture → $exception
    disable_session_recording: local, // cloud: recording on
    ...(local
      ? { opt_out_capturing_by_default: true, persistence: "memory" as const }
      : {
          session_recording: {
            // Inputs are always masked; note bodies / transcripts / Ask-AI text
            // are masked via `.ph-mask-content` on their (shared) containers.
            maskAllInputs: true,
            maskTextSelector: ".ph-mask-content",
          },
        }),
    // Re-registered after each reset() in the identity bridge (reset clears it).
    loaded: (ph) => ph.register(superPropertiesFor(config.platform)),
  });
  ready = true;
}

/**
 * Drop the posthog identity + persisted super-properties ahead of a device
 * reset (capability:resetApp). Main then wipes localstorage/cookies and
 * regenerates the anonymous device id, so the relaunched app shares nothing
 * with the previous identity. No-op when analytics never initialised.
 */
export function resetAnalyticsIdentity(): void {
  if (!ready || initializedPlatform === null) return;
  resetIdentity(initializedPlatform);
}

/**
 * The desktop AnalyticsPort — the shared shell captures product events through
 * this exactly as web does (guarded on init so a disabled build silently drops).
 */
export const desktopAnalyticsPort: AnalyticsPort = {
  capture(event, properties) {
    if (!ready) return;
    posthog.capture(event, properties);
  },
  capturePageview(url) {
    if (!ready) return;
    posthog.capture("$pageview", { $current_url: url });
  },
};

// --- Identity (mirrors the browser client's identity hook) ----------------
// reset() clears the persisted super properties, so re-register them right after.

export function identifyUser(sub: string, props: { email?: string; name?: string }): void {
  posthog.identify(sub, props);
}

export function resetIdentity(platform: string): void {
  posthog.reset();
  posthog.register(superPropertiesFor(platform));
}

export function groupOrg(orgId: string): void {
  posthog.group("organization", orgId);
}
