"use client";

import * as React from "react";
import { useFeatureFlag, useNavigation } from "@prismical/app-client";
import { Loader2 } from "lucide-react";

/**
 * Route-level guard for per-org feature flags. Wrap a page body so a
 * direct URL hit to a gated route is handled even though the nav link is already
 * hidden (defense in depth):
 *
 *   <FeatureGate feature="integrations"><IntegrationsScreen /></FeatureGate>
 *
 * While the active org is still resolving it renders a spinner (never bounces early
 * on an unknown flag); once resolved-and-disabled it redirects to `fallbackHref`.
 */
export function FeatureGate({
  feature,
  children,
  fallbackHref = "/home",
}: {
  feature: string;
  children: React.ReactNode;
  /** Where to send the user when the feature is off for their org. Defaults to home. */
  fallbackHref?: string;
}) {
  const { enabled, isResolved } = useFeatureFlag(feature);
  const router = useNavigation();

  React.useEffect(() => {
    if (isResolved && !enabled) router.replace(fallbackHref);
  }, [isResolved, enabled, router, fallbackHref]);

  // Active org not yet known — don't flash the page or bounce before the flag is known.
  if (!isResolved) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Resolved and disabled: the redirect above is in flight, render nothing meanwhile.
  if (!enabled) return null;

  return <>{children}</>;
}
