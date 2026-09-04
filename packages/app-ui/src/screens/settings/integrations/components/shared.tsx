'use client';

import { Badge } from '../../../../ui/badge';
import { useTranslation } from 'react-i18next';

// Shared bits for the Integrations hub + detail pages. Lives outside the
// page.tsx modules so the detail route doesn't pull the whole hub module graph into its chunk.

export function McpStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();

  switch (status) {
    case 'active':
      return (
        <Badge variant="outline" className="border-success/30 bg-success/10 text-success">
          {t('settings.integrations.status.connected')}
        </Badge>
      );
    case 'needs_auth':
      return (
        <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
          {t('settings.integrations.status.needsAuth')}
        </Badge>
      );
    case 'error':
      return <Badge variant="destructive">{t('settings.integrations.status.error')}</Badge>;
    case 'disabled':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {t('settings.integrations.status.disabled')}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {t('settings.integrations.status.notConnected')}
        </Badge>
      );
  }
}

export function relativeTime(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return null;

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const mins = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (mins < 1) return relative.format(0, 'second');
  if (mins < 60) return relative.format(-mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 48) return relative.format(-hours, 'hour');
  return relative.format(-Math.round(hours / 24), 'day');
}
