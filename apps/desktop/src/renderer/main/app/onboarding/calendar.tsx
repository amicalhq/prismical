import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useConnections,
  useDesktopCapabilities,
  useFeatureFlag,
  useInvalidateConnections,
} from '@prismical/app-client';
import { Button } from '@prismical/app-ui/ui/button';
import { Toaster } from '@prismical/app-ui/ui/sonner';
import { AppleLogo, GoogleCalendarLogo } from '@prismical/app-ui/components/provider-logos';
import { useConnectFlow } from '@prismical/app-ui/lib/use-connect-flow';
import { OnboardingFrame } from './frame';

export function CalendarOnboarding({ onComplete }: { onComplete: () => Promise<void> }) {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const calendar = useFeatureFlag('calendar');
  const apple = useFeatureFlag('eventkitCalendar');
  const connections = useConnections({ refetchInterval: 4000 });
  const invalidate = useInvalidateConnections();
  const connect = useConnectFlow();
  const [appleConnected, setAppleConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const googleConnected = connections.data?.some(
    c => c.provider === 'google' && c.status === 'active'
  );
  const connected =
    googleConnected || appleConnected || connections.data?.some(c => c.status === 'active');

  useEffect(
    () =>
      window.desktop.nav.onPush(({ path }) => {
        const url = new URL(path, 'https://prismical.local');
        if (url.pathname !== '/settings/calendar') return;
        if (url.searchParams.has('error'))
          setError(t('settings.calendar.toasts.connectStartFailed'));
        else {
          setError(null);
          invalidate();
        }
      }),
    [invalidate, t]
  );

  const enableApple = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await caps.enableAppleCalendar();
      if (status.permission === 'granted' && status.state !== 'error') {
        setAppleConnected(true);
        invalidate();
      } else {
        setError(
          t(
            status.permission === 'denied' || status.permission === 'restricted'
              ? 'settings.calendar.toasts.accessBlocked'
              : 'settings.calendar.toasts.appleConnectFailed'
          )
        );
      }
    } catch {
      setError(t('settings.calendar.toasts.appleConnectFailed'));
    } finally {
      setBusy(false);
    }
  };
  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      await onComplete();
    } catch {
      setError(t('desktop.modeChooser.failed'));
      setBusy(false);
    }
  };

  return (
    <OnboardingFrame
      step="calendar"
      testId="onboarding-calendar"
      error={error}
      footer={
        <>
          <p className="text-muted-foreground text-xs">{t('desktop.onboarding.calendar.later')}</p>
          <Button data-testid="onboarding-finish" disabled={busy} onClick={() => void complete()}>
            {t(connected ? 'desktop.onboarding.finish' : 'desktop.onboarding.skip')}
          </Button>
        </>
      }
    >
      {calendar.enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            variant="outline"
            className="h-auto justify-start gap-3 p-4"
            disabled={busy || connect.pending || googleConnected}
            onClick={() => {
              setError(null);
              connect.start('google');
            }}
          >
            <GoogleCalendarLogo className="size-6" />
            {googleConnected
              ? t('settings.calendar.toasts.connected')
              : t('settings.calendar.actions.connectGoogle')}
          </Button>
          {apple.enabled && caps.has('apple-calendar') && (
            <Button
              variant="outline"
              className="h-auto justify-start gap-3 p-4"
              disabled={busy || appleConnected}
              onClick={() => void enableApple()}
            >
              <AppleLogo className="size-6" />
              {t(
                appleConnected
                  ? 'settings.calendar.actions.appleConnected'
                  : 'settings.calendar.actions.connectApple'
              )}
            </Button>
          )}
        </div>
      )}
      <Toaster />
    </OnboardingFrame>
  );
}
