/**
 * DesktopPostHogProvider initializes posthog-js once from
 * main's env descriptor and keeps its identity synced to the desktop auth
 * session. Mounts inside PortsProvider (so useSessionView is available) and
 * renders children untouched. When analytics is disabled (no key/host — dev/e2e)
 * it never initialises, so every capture stays a no-op.
 */
import * as React from "react";
import { useSessionView } from "@prismical/app-client";
import type { EnvDescriptor as DesktopEnvDescriptor } from "@prismical/desktop-contracts";
import {
  groupOrg,
  identifyUser,
  initDesktopPostHog,
  isPostHogReady,
  resetIdentity,
} from "./posthog";

export function DesktopPostHogProvider({
  env,
  enabled,
  children,
}: {
  env: DesktopEnvDescriptor;
  /**
   * False while the first-run chooser is up: a fresh install
   * boots 'cloud' by default, but nothing may beacon under the cloud policy
   * (autocapture, session replay) before the user has picked a mode.
   */
  enabled: boolean;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    // Initialize only once the mode is known and chosen: the
    // descriptor carries appMode, and the baseline config differs per mode —
    // nothing may beacon before the policy is decided.
    if (enabled && env.analyticsKey && env.analyticsHost && env.appMode) {
      initDesktopPostHog({
        key: env.analyticsKey,
        host: env.analyticsHost,
        platform: env.platform,
        appMode: env.appMode,
      });
    }
  }, [env, enabled]);

  // Local mode never identifies: the AuthPort serves the
  // synthetic 'local-user' session, and identifying it would merge every
  // opted-in local install into ONE PostHog person. The anonymous per-install
  // id is the whole identity there.
  useDesktopPostHogIdentify(env.platform, env.appMode === 'cloud');
  return <>{children}</>;
}

/**
 * Identify on login, group by the active organization, and reset on logout / an
 * account switch so events and recordings never bleed across users on one device
 * (mirrors web's use-posthog-identify; distinctId = account.sub).
 */
function useDesktopPostHogIdentify(platform: string, mirrorSession: boolean): void {
  const session = useSessionView();
  // The last sub we called identify() with — avoids re-identifying on every
  // render and lets us detect an account switch (sub A → sub B).
  const identifiedRef = React.useRef<string | null>(null);

  const active = mirrorSession
    ? session.accounts.find((account) => account.sub === session.activeSub)
    : undefined;
  const sub = active?.sub ?? null;
  const email = active?.email;
  const name = active?.name;
  const orgId = active?.activeOrgId;

  React.useEffect(() => {
    if (!isPostHogReady()) return;
    if (!sub) {
      // Logged out (or mid account-switch with no active account): drop identity.
      if (identifiedRef.current) {
        resetIdentity(platform);
        identifiedRef.current = null;
      }
      return;
    }
    if (identifiedRef.current !== sub) {
      // Switching directly from another account — reset first so the new person's
      // events aren't merged into the previous distinct id.
      if (identifiedRef.current) resetIdentity(platform);
      identifyUser(sub, { email, name });
      identifiedRef.current = sub;
    }
    if (orgId) groupOrg(orgId);
  }, [sub, email, name, orgId, platform]);
}
