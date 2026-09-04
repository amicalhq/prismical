'use client';

import type { ReactNode } from 'react';
import { LogExportSetting } from './log-export-setting';
import { AppResetSetting } from './app-reset-setting';
import { useTranslation } from 'react-i18next';

/**
 * `modeSettings`: the platform's app-mode card — the desktop
 * router passes its desktop-owned card (switch local ⇄ cloud); web passes
 * nothing. A named slot, not a capability branch in this screen.
 */
export function AdvancedScreen({ modeSettings }: { modeSettings?: ReactNode } = {}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('settings.advanced.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('settings.advanced.description')}</p>
      </div>

      <div className="space-y-6">
        {/* Only implemented desktop actions remain; debug mode remains a todo. */}
        <LogExportSetting />
        {modeSettings}
        <AppResetSetting />
      </div>
    </div>
  );
}
