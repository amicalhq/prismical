'use client';

import { ArrowUpRight, CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useActiveOrgId,
  useEnv,
  useOrganizations,
  usePorts,
  type OrganizationRole,
} from '@prismical/app-client';
import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Skeleton } from '../../ui/skeleton';

export function canManageOrganizationBilling(role: OrganizationRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function webBillingUrl(webAppOrigin: string): string {
  return new URL('/settings/billing', webAppOrigin).toString();
}

/**
 * Desktop keeps checkout and portal work in the web app. The ExternalPort turns this same-origin
 * URL into a short-lived authenticated browser handoff for the active desktop account and org.
 */
export function BillingHandoffScreen() {
  const { t } = useTranslation();
  const activeOrgId = useActiveOrgId();
  const organizations = useOrganizations();
  const { external } = usePorts();
  const { webAppOrigin } = useEnv();
  const activeOrganization = organizations.data?.find(org => org.orgId === activeOrgId);

  if (organizations.isPending) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold">{t('settings.billing.screen.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings.billing.screen.loadingDescription')}
          </p>
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!activeOrganization || !canManageOrganizationBilling(activeOrganization.role)) {
    return (
      <div>
        <h1 className="text-xl font-bold">{t('settings.billing.screen.title')}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {t('settings.billing.screen.adminOnly')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">{t('settings.billing.screen.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settings.billing.handoff.description', { name: activeOrganization.name })}
        </p>
      </div>

      <Card className="max-w-2xl bg-card/60">
        <CardHeader>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <CreditCard className="size-4" aria-hidden="true" />
            {t('settings.billing.handoff.browserLabel')}
          </div>
          <CardTitle className="pt-2 text-lg">{t('settings.billing.handoff.continue')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('settings.billing.handoff.browserDescription', {
              name: activeOrganization.name,
            })}
          </p>
          <Button
            type="button"
            onClick={() => external.openExternalUrl(webBillingUrl(webAppOrigin))}
          >
            {t('settings.billing.handoff.manageOnWeb')}
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
