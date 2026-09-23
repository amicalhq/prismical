'use client';

import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEntitlements } from '@prismical/app-client';
import { AppLink } from '../../../../shell/app-link';
import { Button } from '../../../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../ui/dialog';

/**
 * Whether the plan lets this org use its own provider keys. `pending` while the plan loads: BYOK
 * controls stay locked but nothing upsells, so a paid org never sees an upgrade prompt flash.
 */
export type ByokAccess = 'allowed' | 'locked' | 'pending';

/**
 * Where "upgrade" leads. Lifetime-deal tiers upgrade on the marketplace listing, not in billing -
 * the same split the Ask composer makes - and their offer is a higher tier, not Pro.
 */
export function useUpgradeTarget() {
  const { entitlements } = useEntitlements();
  const tier = /^plan_appsumo_tier_\d+$/.test(entitlements.planExternalId ?? '');
  return tier
    ? {
        href: 'https://appsumo.com/products/prismical/',
        external: true,
        keys: {
          availability: 'settings.aiModels.planGate.tier.availability',
          description: 'settings.aiModels.planGate.tier.description',
          upgrade: 'settings.aiModels.planGate.tier.upgrade',
          bannerTitle: 'settings.aiModels.planGate.tier.bannerTitle',
          lockedBadge: 'settings.aiModels.planGate.tier.lockedBadge',
          lockedAria: 'settings.aiModels.planGate.tier.lockedAria',
        },
      } as const
    : {
        href: '/settings/billing',
        external: false,
        keys: {
          availability: 'settings.aiModels.planGate.availability',
          description: 'settings.aiModels.planGate.description',
          upgrade: 'settings.aiModels.planGate.upgrade',
          bannerTitle: 'settings.aiModels.planGate.bannerTitle',
          lockedBadge: 'settings.aiModels.planGate.lockedBadge',
          lockedAria: 'settings.aiModels.planGate.lockedAria',
        },
      } as const;
}

function UpgradeLink({ size }: { size?: 'sm' }) {
  const { t } = useTranslation();
  const target = useUpgradeTarget();
  return (
    <Button asChild size={size} className="shrink-0">
      {target.external ? (
        <a href={target.href} target="_blank" rel="noopener noreferrer">
          {t(target.keys.upgrade)}
        </a>
      ) : (
        <AppLink href={target.href}>{t(target.keys.upgrade)}</AppLink>
      )}
    </Button>
  );
}

/** Opened from any locked BYOK control. The rest of the page stays usable behind it. */
export function ByokUpgradeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { keys } = useUpgradeTarget();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl border bg-muted">
            <KeyRound aria-hidden="true" className="size-5" />
          </div>
          <p className="text-xs font-medium text-muted-foreground">
            {t(keys.availability)}
          </p>
          <DialogTitle>{t('settings.aiModels.planGate.title')}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t(keys.description)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('settings.aiModels.planGate.notNow')}
          </Button>
          <UpgradeLink />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Inline upsell above the provider tiles, in place of a wall over the whole page. */
export function ByokUpgradeBanner() {
  const { t } = useTranslation();
  const { keys } = useUpgradeTarget();
  return (
    <div className="mb-3 flex flex-col gap-3 rounded-md border bg-muted/50 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{t(keys.bannerTitle)}</p>
          <p className="text-xs text-muted-foreground">
            {t('settings.aiModels.planGate.bannerDescription')}
          </p>
        </div>
      </div>
      <UpgradeLink size="sm" />
    </div>
  );
}
