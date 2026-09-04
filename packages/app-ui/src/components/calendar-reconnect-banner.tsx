'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { AppLink as Link } from '../shell/app-link';
import { Button } from '../ui/button';
import { useConnections } from '@prismical/app-client';
import { useConnectFlow } from '../lib/use-connect-flow';
import { useTranslation } from 'react-i18next';

/**
 * Amber "reconnect needed" banner for meeting surfaces (Home's Upcoming meetings, Events).
 * Renders only while at least one calendar connection is erroring (server flipped
 * status='error' on a revoked token), and disappears on its own once a reconnect succeeds -
 * the OAuth revive folds the fresh grant into the same connection, so no dismissal state is
 * needed (a dismissed broken calendar is exactly the invisible-failure gap this closes).
 *
 * One erroring account launches the OAuth consent directly; with several, the button leads to
 * Settings -> Calendar where each account has its own Reconnect.
 */
export function CalendarReconnectBanner() {
  const { t } = useTranslation();
  const connections = useConnections();
  const connect = useConnectFlow();
  const erroring = (connections.data ?? []).filter(c => c.status === 'error');
  if (erroring.length === 0) return null;

  const single = erroring.length === 1 ? erroring[0] : undefined;
  return (
    <div
      role="alert"
      className="mb-3 flex items-center gap-3 rounded-lg border border-warning/35 bg-warning/10 px-3.5 py-2.5 text-xs text-warning"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        {single ? (
          <>
            <span className="font-semibold">{t('calendar.reconnect.singleTitle')}</span>{' '}
            {t('calendar.reconnect.singleDescription', {
              account: single.accountEmail ?? t('calendar.reconnect.yourAccount'),
            })}
          </>
        ) : (
          <>
            <span className="font-semibold">
              {t('calendar.reconnect.multipleTitle', { count: erroring.length })}
            </span>{' '}
            — {t('calendar.reconnect.multipleDescription')}
          </>
        )}
      </p>
      {single ? (
        <Button
          type="button"
          size="sm"
          disabled={connect.pending}
          onClick={() => connect.start(single.provider)}
          className="h-7 shrink-0 bg-warning px-2.5 text-xs font-semibold text-warning-foreground hover:bg-warning/80"
        >
          {connect.pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {connect.pending
            ? t('calendar.reconnect.reconnecting')
            : t('calendar.reconnect.reconnect')}
        </Button>
      ) : (
        <Button
          asChild
          size="sm"
          className="h-7 shrink-0 bg-warning px-2.5 text-xs font-semibold text-warning-foreground hover:bg-warning/80"
        >
          <Link href="/settings/calendar">{t('calendar.reconnect.openSettings')}</Link>
        </Button>
      )}
    </div>
  );
}
