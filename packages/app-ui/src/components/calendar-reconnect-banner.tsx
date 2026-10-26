'use client';

import { AlertTriangle } from 'lucide-react';
import { AppLink as Link } from '../shell/app-link';
import { Button } from '../ui/button';
import { useConnections } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

/**
 * Amber "reconnect needed" banner for meeting surfaces (Home's Upcoming meetings, Events).
 * Renders only while at least one calendar connection is erroring (server flipped
 * status='error' after authentication recovery fails), and disappears on its own once a reconnect succeeds -
 * the OAuth revive folds the fresh grant into the same connection, so no dismissal state is
 * needed (a dismissed broken calendar is exactly the invisible-failure gap this closes).
 *
 * The action always opens Calendar settings, where each account has its own Reconnect.
 */
export function CalendarReconnectBanner() {
  const { t } = useTranslation();
  const connections = useConnections({ refetchInterval: 60_000 });
  const erroring = (connections.data ?? []).filter(c => c.status === 'error');
  if (erroring.length === 0) return null;

  const single = erroring.length === 1 ? erroring[0] : undefined;
  return (
    <div
      role="alert"
      className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-warning/35 bg-warning/10 px-3.5 py-2.5 text-xs text-warning"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-48 break-words">
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
      <Button
        asChild
        variant="outline"
        size="sm"
        className="h-7 border-warning/35 bg-transparent px-2.5 text-xs text-warning hover:bg-warning/10 hover:text-warning"
      >
        <Link href="/settings/calendar">{t('calendar.reconnect.openSettings')}</Link>
      </Button>
    </div>
  );
}
