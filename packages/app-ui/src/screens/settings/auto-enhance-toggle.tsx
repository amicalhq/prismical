'use client';

import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { useAutoEnhanceEnabled } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// The one wired preference on this page: after you stop a recording, auto-run Enhance on
// it and stage the result for review. Per-device (localStorage), default on.
export function AutoEnhanceToggle() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useAutoEnhanceEnabled();
  return (
    <div className="flex items-center justify-between">
      <div className="space-y-1">
        <Label htmlFor="auto-enhance" className="text-base font-medium text-foreground">
          {t('settings.preferences.autoEnhance.label')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t('settings.preferences.autoEnhance.description')}
        </p>
      </div>
      <Switch id="auto-enhance" checked={enabled} onCheckedChange={setEnabled} />
    </div>
  );
}
