/**
 * The mode router — the pure half.
 *
 * The one line that used to gate the product ("no active account ⇒ render
 * nothing, the auth gate owns the surface") becomes a router over the app mode:
 *
 *   mode not chosen yet     → the first-run chooser (desktop-owned)
 *   local                   → the product shell (accountless by construction)
 *   cloud + active account  → optional calendar setup, then the product shell
 *   cloud + no account      → the auth gate (mounted in its own root, index.ts)
 *
 * Kept free of React so the decision table is unit-testable; mount.tsx renders
 * the surface it names.
 */
import type { AppModeValue, OnboardingState } from '@prismical/desktop-contracts';

export type DesktopSurface = 'chooser' | 'gate' | 'calendar' | 'shell';

export interface SurfaceInputs {
  readonly appMode: AppModeValue;
  /** False only on a fresh install until a mode is persisted. */
  readonly appModeChosen: boolean;
  /** Cloud mode only: the sanitized session names an active account. */
  readonly hasActiveAccount: boolean;
  readonly onboarding?: OnboardingState | null;
}

export const resolveSurface = ({
  appMode,
  appModeChosen,
  hasActiveAccount,
  onboarding,
}: SurfaceInputs): DesktopSurface => {
  if (!appModeChosen) return 'chooser';
  if (appMode === 'local') return 'shell';
  if (!hasActiveAccount) return 'gate';
  return onboarding?.step === 'calendar' ? 'calendar' : 'shell';
};
