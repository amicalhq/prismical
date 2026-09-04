'use client';

import * as React from 'react';
import { useDesktopCapabilities } from '@prismical/app-client';
import type {
  PermissionKind,
  PermissionStatus,
  PermissionStatuses,
} from '@prismical/app-contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Separator } from '../../ui/separator';
import { useTranslation } from 'react-i18next';

/** Status → badge variant. `granted` is the only positive state. */
const STATUS_VARIANT: Record<
  PermissionStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  granted: 'default',
  denied: 'destructive',
  'not-determined': 'secondary',
  restricted: 'destructive',
  unavailable: 'outline',
  unknown: 'outline',
};

const STATUS_KEYS = {
  granted: 'settings.permissions.status.granted',
  denied: 'settings.permissions.status.denied',
  'not-determined': 'settings.permissions.status.notDetermined',
  restricted: 'settings.permissions.status.restricted',
  unavailable: 'settings.permissions.status.unavailable',
  unknown: 'settings.permissions.status.unknown',
} as const satisfies Record<PermissionStatus, string>;

function StatusBadge({ status }: { status: PermissionStatus | undefined }) {
  const { t } = useTranslation();
  if (status === undefined) {
    return (
      <span className="text-xs text-muted-foreground">
        {t('settings.permissions.status.checking')}
      </span>
    );
  }
  return <Badge variant={STATUS_VARIANT[status]}>{t(STATUS_KEYS[status])}</Badge>;
}

function PermissionRow({
  title,
  description,
  status,
  onGrant,
  onOpenSettings,
}: {
  title: string;
  description: string;
  status: PermissionStatus | undefined;
  onGrant?: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const unavailable = status === 'unavailable';
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-medium text-foreground">{title}</span>
          <StatusBadge status={status} />
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onGrant && status !== 'granted' && !unavailable ? (
          <Button variant="outline" size="sm" onClick={onGrant}>
            {t('settings.permissions.grant')}
          </Button>
        ) : null}
        {unavailable ? null : (
          <Button variant="ghost" size="sm" onClick={onOpenSettings}>
            {t('settings.permissions.openSystemSettings')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Native permission surface. Desktop-only: hidden on web
 * where `has('mic-devices')` is false. Reads the live mic + system-audio status
 * from main (fetch on mount + on window focus — so returning from System Settings
 * refreshes the readout — and after a request), offers the mic TCC prompt, and
 * deep-links to the OS privacy pane.
 */
export function PermissionsSetting() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const enabled = caps.has('mic-devices');
  const [statuses, setStatuses] = React.useState<PermissionStatuses | undefined>(undefined);

  const refresh = React.useCallback(() => {
    caps.getPermissionStatus().then(setStatuses, () => {});
  }, [caps]);

  React.useEffect(() => {
    if (!enabled) return;
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [enabled, refresh]);

  if (!enabled) return null;

  const request = (kind: PermissionKind) => {
    caps.requestPermission(kind).then(setStatuses, () => {});
  };
  const openSettings = (kind: PermissionKind) => {
    void caps.openSystemSettings(kind);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.permissions.title')}</CardTitle>
        <CardDescription>{t('settings.permissions.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PermissionRow
          title={t('settings.permissions.microphoneLabel')}
          description={t('settings.permissions.microphoneDescription')}
          status={statuses?.microphone}
          onGrant={() => request('microphone')}
          onOpenSettings={() => openSettings('microphone')}
        />
        <Separator />
        <PermissionRow
          title={t('settings.permissions.systemAudioLabel')}
          description={t('settings.permissions.systemAudioDescription')}
          status={statuses?.systemAudio}
          onOpenSettings={() => openSettings('system-audio')}
        />
      </CardContent>
    </Card>
  );
}
