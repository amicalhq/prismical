'use client';

import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { useActiveOrgId, useFeatureFlag } from '@prismical/app-client';
import { useOrganizations } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// Owner-only "danger zone" for the active organization. Deletion is handled manually
// for now: the button opens a pre-filled email to support with the
// org id, rather than a self-serve destructive flow.
export function OrganizationDangerZone() {
  const { t } = useTranslation();
  const activeOrgId = useActiveOrgId();
  const { data: orgs } = useOrganizations();
  const activeOrg = orgs?.find(o => o.orgId === activeOrgId) ?? null;
  const { enabled: organizationEnabled } = useFeatureFlag('organization');

  // Nothing to delete without the organization feature (the desktop local
  // workspace); otherwise only owners can request deletion.
  if (!organizationEnabled) return null;
  if (!activeOrg || activeOrg.role !== 'owner') return null;

  const subject = t('settings.organization.delete.subject', { orgId: activeOrg.orgId });
  const mailto = `mailto:help@prismical.ai?subject=${encodeURIComponent(subject)}`;

  return (
    <Card className="border-destructive/30">
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-base font-medium text-foreground">
            {t('settings.organization.delete.label')}
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            {t('settings.organization.delete.description', {
              name: activeOrg.name || t('settings.organization.delete.fallbackName'),
            })}
          </p>
        </div>
        <Button asChild variant="destructive">
          <a href={mailto}>{t('settings.organization.delete.action')}</a>
        </Button>
      </CardContent>
    </Card>
  );
}
