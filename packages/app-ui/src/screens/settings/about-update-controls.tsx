'use client';

import * as React from 'react';
import { useDeviceSettings, useDesktopCapabilities } from '@prismical/app-client';
import type { UpdateChannel, UpdateStateView, UpdateStatus } from '@prismical/app-contracts';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Label } from '../../ui/label';
import { Button } from '../../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';

/**
 * Update surface. Desktop-only: hidden
 * on web where `has('app-updates')` is false. Persists the stable/beta channel
 * via the device setting, runs a "Check for updates" against the real
 * autoUpdater, and mirrors the live updater view — a staged install surfaces
 * the "Restart to install" action regardless of how it was discovered
 * (manual check or a background one).
 */
export function AboutUpdateControls() {
  const { t } = useTranslation();
  const { settings, set, has } = useDeviceSettings();
  const caps = useDesktopCapabilities();
  const [status, setStatus] = React.useState<UpdateStatus | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [view, setView] = React.useState<UpdateStateView | null>(null);
  const enabled = has('app-updates');
  const statusLabels: Record<UpdateStatus, string> = {
    disabled: t('settings.about.updates.status.disabled'),
    'not-available': t('settings.about.updates.status.upToDate'),
    checking: t('settings.about.updates.status.checking'),
    available: t('settings.about.updates.status.downloading'),
    downloaded: t('settings.about.updates.status.ready'),
    error: t('settings.about.updates.status.error'),
  };

  React.useEffect(() => {
    if (!enabled) return;
    // Seed from the current view (survives a renderer reload — the push only
    // fires on a state change), then track live updates.
    let active = true;
    void caps.getUpdateState().then(v => {
      if (active) setView(v);
    });
    const off = caps.onUpdateState(setView);
    return () => {
      active = false;
      off();
    };
  }, [enabled, caps]);

  if (!enabled) return null;

  const check = () => {
    setChecking(true);
    caps.checkForUpdates().then(
      result => {
        setStatus(result.status);
        setChecking(false);
      },
      () => {
        setStatus('error');
        setChecking(false);
      }
    );
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="update-channel" className="text-base font-medium text-foreground">
            {t('settings.about.updates.channelLabel')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.about.updates.channelDescription')}
          </p>
        </div>
        <Select
          value={settings.updateChannel}
          onValueChange={value => set({ updateChannel: value as UpdateChannel })}
        >
          <SelectTrigger id="update-channel" className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">{t('settings.about.updates.stable')}</SelectItem>
            <SelectItem value="beta">{t('settings.about.updates.beta')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {view?.staged ? statusLabels.downloaded : status === null ? '' : statusLabels[status]}
        </p>
        <div className="flex items-center gap-2">
          {view?.staged ? (
            <Button
              size="sm"
              onClick={() => void caps.restartToUpdate()}
              className="flex items-center gap-2"
            >
              <RotateCcw className="h-4 w-4" />
              {t('settings.about.updates.restartToInstall')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={check}
            disabled={checking}
            className="flex items-center gap-2"
          >
            <RefreshCw className={`h-4 w-4${checking ? ' animate-spin' : ''}`} />
            {t('settings.about.updates.check')}
          </Button>
        </div>
      </div>
    </div>
  );
}
