"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useConnectCalendar } from "@prismical/app-client";

// Final backstop for releasing the connect latch if neither the page-unload (web) nor the
// window-blur (desktop) signal arrives — e.g. a redirect that silently fails to navigate. Long
// enough to clear any real consent redirect's commit, so it never fires on the happy path.
const CONNECT_LATCH_RELEASE_MS = 10_000;

/**
 * Starts the calendar OAuth connect flow from anywhere (settings, Home prompt, Events empty
 * state). The provider callback always redirects back to /settings/calendar, so every entry
 * point lands the user on the settings page when the consent round-trip finishes.
 *
 * Wraps the connect mutation so the button holds its loading state through the hand-off to the
 * provider. `useConnectCalendar`'s `isPending` clears the instant the `authorize` POST resolves —
 * a beat before `onSuccess` opens the consent URL — so the button would flash back to its idle
 * state in that gap (the flicker). We latch it and release only once the hand-off has visibly
 * happened, which differs by platform (without branching on it):
 *   - Web: `openAuthorizationUrl` is `window.location.assign` — the page unloads and this
 *     component unmounts while still latched. The window keeps focus during the redirect, so
 *     `blur` doesn't fire early; no flicker.
 *   - Desktop: `openAuthorizationUrl` is `window.open` (main opens the OS browser; the app window
 *     stays mounted). The OS browser taking foreground blurs this window, which releases the
 *     latch promptly so the button never sticks on "Connecting…".
 * The timeout is a last-resort backstop; a start failure toasts and releases immediately so a
 * retry is possible (a toast rather than an inline banner, so callers outside the settings page
 * need no error surface of their own).
 */
export function useConnectFlow() {
  const { t } = useTranslation();
  const connect = useConnectCalendar();
  const [redirecting, setRedirecting] = React.useState(false);
  React.useEffect(() => {
    if (!redirecting) return;
    const release = () => setRedirecting(false);
    window.addEventListener("blur", release);
    const t = setTimeout(release, CONNECT_LATCH_RELEASE_MS);
    return () => {
      window.removeEventListener("blur", release);
      clearTimeout(t);
    };
  }, [redirecting]);
  const start = React.useCallback(
    (provider: string) => {
      setRedirecting(true);
      connect.mutate(provider, {
        onError: (err) => {
          setRedirecting(false);
          console.error("calendar connection could not start", err);
          toast.error(t("settings.calendar.toasts.connectStartFailed"));
        },
      });
    },
    [connect, t],
  );
  return { start, pending: connect.isPending || redirecting };
}
