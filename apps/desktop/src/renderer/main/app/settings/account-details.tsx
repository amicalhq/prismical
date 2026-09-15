import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight } from 'lucide-react';
import { ViewerProfileResponseSchema } from '@prismical/api-contracts/apps/v1';
import {
  useActiveAccountId,
  useActiveOrgId,
  usePorts,
  useViewerProfile,
  viewerProfileKey,
} from '@prismical/app-client';
import { ProfileForm } from '@prismical/app-ui/screens/settings/account/profile-form';
import { Button } from '@prismical/app-ui/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@prismical/app-ui/ui/card';

export function DesktopAccountDetails() {
  const accountId = useActiveAccountId();
  return accountId ? <AccountDetailsForAccount key={accountId} accountId={accountId} /> : null;
}

function AccountDetailsForAccount({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { auth } = usePorts();
  const activeOrgId = useActiveOrgId();
  const profile = useViewerProfile();
  const queryClient = useQueryClient();
  const [saved, setSaved] = React.useState(false);
  const current = React.useRef(true);
  React.useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const save = useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: async (body: { name: string; image?: string | null }) => {
      // Main checks this identity before waiting for or dispatching a workspace request.
      const response = await window.desktop.transport.request({
        method: 'PATCH',
        path: '/apps/v1/me/profile',
        body,
        expectedAccountId: accountId,
      });
      if ('error' in response || response.status < 200 || response.status >= 300) {
        throw new Error('Profile update failed');
      }
      return ViewerProfileResponseSchema.parse(response.bodyJson);
    },
    onSuccess: value => {
      if (!current.current || auth.getSession().activeSub !== accountId) return;
      queryClient.setQueryData(viewerProfileKey, value);
      setSaved(true);
    },
  });
  const handoff = useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: () =>
      window.desktop.auth.openWebSession({
        returnPath: '/settings/account',
        ...(activeOrgId ? { activeOrgId } : {}),
      }),
  });
  return (
    <>
      {saved && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('settings.account.controls.saved')}
        </p>
      )}
      {profile.isPending ? (
        <p role="status">{t('common.status.loading')}</p>
      ) : profile.data ? (
        <ProfileForm
          profile={profile.data}
          pending={save.isPending}
          error={save.error ? t('settings.account.controls.failed') : ''}
          onSave={body => {
            setSaved(false);
            save.mutate(body);
          }}
        />
      ) : (
        <p role="alert">
          {t('settings.account.controls.failed')}{' '}
          <Button variant="outline" onClick={() => void profile.refetch()}>
            {t('settings.account.controls.retry')}
          </Button>
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.account.controls.email')}</CardTitle>
          <CardDescription>{t('settings.account.controls.emailDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="break-all text-sm">{profile.data?.email}</p>
          <Button variant="outline" asChild>
            <a href="mailto:help@prismical.ai?subject=Request%20email%20change">
              {t('settings.account.controls.requestEmail')}
            </a>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.account.securityHandoff.title')}</CardTitle>
          <CardDescription>{t('settings.account.securityHandoff.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button disabled={handoff.isPending} onClick={() => handoff.mutate()}>
            {t('settings.account.securityHandoff.action')}
            <ArrowUpRight aria-hidden="true" />
          </Button>
          {handoff.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('settings.account.controls.failed')}
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
