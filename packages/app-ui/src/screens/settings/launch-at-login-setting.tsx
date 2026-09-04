'use client';

import { useDeviceSettings } from '@prismical/app-client';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Separator } from '../../ui/separator';
import { useTranslation } from 'react-i18next';

/**
 * Launch-at-login control. Desktop-only: the OS login item
 * exists only in the native app, so the whole row is hidden on web where
 * `has('launch-at-login')` is false. As the FIRST item in the preferences card it
 * owns its TRAILING separator (the mirror of DockSettings' leading ones)
 * — hiding it on web removes the row AND the separator, leaving the next control
 * as a clean first item. Reads/writes the device setting live through
 * useDeviceSettings; the main-side os-sync consumer applies the OS effect.
 */
export function LaunchAtLoginSetting() {
  const { t } = useTranslation();
  const { settings, set, has } = useDeviceSettings();
  if (!has('launch-at-login')) return null;

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Label htmlFor="launch-at-login" className="text-base font-medium text-foreground">
            {t('settings.preferences.launchAtLogin.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.preferences.launchAtLogin.description')}
          </p>
        </div>
        <Switch
          id="launch-at-login"
          checked={settings.launchAtLogin}
          onCheckedChange={checked => set({ launchAtLogin: checked })}
        />
      </div>
      <Separator />
    </>
  );
}
