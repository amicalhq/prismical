'use client';

// What the interface says about the account's plan, in two places.
//
// SidebarPlanBadge is the upgrade offer, and it rides the profile menu's Billing
// row. It is NOT a link: that row already goes where upgrading happens, so a
// link inside it would be a second target inside a control that is already one.
// It lived in the sidebar foot before, nested inside the account menu's own
// trigger button - which is invalid markup, opened the menu on the way to
// billing (Radix opens on pointerdown, which a click guard never sees), and left
// screen readers announcing one control named "Naomi Upgrade".
//
// SidebarPlanPill names a PAID plan beside the person in the foot. Free accounts
// get nothing there now; the offer is one click away in their menu.
//
// That shortening is the ONE place in this package that reads a plan name for
// meaning, and it is deliberate: the alternative was a new field on the plan
// payload, which is a backend change for a label. It stays safe because it is
// presentation only — it decides how a name is DRAWN, never what an account is
// entitled to, which is core's alone. Do not grow a second case here; if a
// client ever needs to act on a plan, a tier or a vendor, core sends the answer.
//
// KNOWN GAP: `/me/plan` is owner/admin only (PLAN_VIEW_ROLES in core's
// plan route), so a plain member gets a 403 and no chip. The un-gated `/me`
// carries planDisplayName but is the app identity lane with no client hook.
// Until core exposes the display name on a payload every member can read, the
// chip is silent for members rather than guessing.

import { usePlanAccess } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

/** Past this the name is cut: it shares the foot row with a name and three controls. */
const MAX_NAME_CHARS = 12;

/**
 * The plan name, shortened to fit the chip.
 *
 * Drops the two words that carry nothing here - "Plan", since everything in the
 * catalog is one, and the partner's name, since the account already belongs to
 * it and the tier is what differs. So "Pro Plan" reads "Pro" and "AppSumo
 * Tier 1" reads "Tier 1". Any other name is shown as it comes, cut to fit.
 *
 * This is presentation, not entitlement: nothing downstream branches on the
 * result, and the full name stays on the element's title. Core remains the only
 * place that decides what a plan GRANTS.
 */
function compactPlanName(displayName: string): string {
  const name =
    displayName
      .replace(/\bappsumo\b/gi, '')
      .replace(/\bplan\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || displayName;
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS).trimEnd()}...` : name;
}

/**
 * The upgrade offer, for the Billing row of the profile menu. Indigo rather than
 * the app's accent: the accent marks the current thing, and this is an offer.
 *
 * Never a link, in either placement. In the menu the Billing row it sits on
 * already navigates; in the sidebar foot the account trigger it sits inside
 * opens that very menu. Making it its own target is what broke it the first
 * time: an <a> nested in the trigger button is invalid markup, it opened the
 * menu on the way to billing (Radix opens on pointerdown, which a click guard
 * never sees), and screen readers announced one control called "Naomi
 * Upgrade". A span costs nothing and neither surface loses a route.
 */
export function SidebarPlanBadge() {
  const { t } = useTranslation();
  const { data } = usePlanAccess();
  if (!data?.plan.isFreeTier) return null;
  return (
    <span className="ml-auto shrink-0 rounded-full bg-indigo-500/12 px-1.5 py-px text-[10px] leading-4 font-medium text-indigo-600 dark:text-indigo-300">
      {t('navigation.quota.action.upgrade')}
    </span>
  );
}

export function SidebarPlanPill() {
  const { data } = usePlanAccess();

  // Loading, or a member who cannot read the plan: draw nothing rather than a
  // placeholder that would flicker into a different word.
  //
  // Deliberately NOT `isError || !data`. A member's 403 leaves no data, so the
  // absence covers it - while an owner whose background refetch fails still
  // HOLDS the cached plan, and checking isError would blank a chip that was
  // showing correctly a moment earlier.
  if (!data) return null;

  const { isFreeTier, displayName } = data.plan;
  // Free says nothing here; its offer is the badge in the menu.
  if (isFreeTier) return null;

  // A paid plan is a fact, not an action: quiet text after the name, not a chip
  // competing with it. Reads "Naomi - Pro", "Naomi - Tier 1".
  return (
    <span
      className="-ml-1 shrink-0 truncate text-xs text-sidebar-foreground-muted"
      title={displayName}
    >
      {/* Spacing is margin, not a literal space around the dot: the row's flex
          gap already separates this from the name, and a leading space stacked
          on top of it left a visible hole once the name truncated. The -ml-1
          claws back half that gap for the same reason - a separator wants to
          sit closer to what it separates than the icons do to each other.

          The dot goes entirely once the name clamps: an ellipsis already reads
          as a break, so the two together were dots beside dots, and closing the
          space between them instead only ran them into one another. */}
      <span aria-hidden="true" className="mr-[3px] group-data-[name-clamped]/account-name:hidden">
        ·
      </span>
      {compactPlanName(displayName)}
    </span>
  );
}
