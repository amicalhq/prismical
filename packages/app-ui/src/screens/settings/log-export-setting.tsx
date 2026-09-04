'use client';

import { useDesktopCapabilities } from '@prismical/app-client';
import { FileText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { Label } from '../../ui/label';
import { Button } from '../../ui/button';
import { useTranslation } from 'react-i18next';

/**
 * Logs export. Desktop-only Card, hidden on web where
 * `has('log-export')` is false. Reveals the app log file in the OS file browser
 * for diagnostics (main runs shell.showItemInFolder on the electron-log file).
 */
export function LogExportSetting() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  if (!caps.has('log-export')) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.advanced.diagnostics.title')}</CardTitle>
        <CardDescription>{t('settings.advanced.diagnostics.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-base font-medium text-foreground">
              {t('settings.advanced.diagnostics.logsLabel')}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t('settings.advanced.diagnostics.logsDescription')}
            </p>
          </div>
          <Button
            variant="outline"
            className="flex items-center gap-2"
            onClick={() => void caps.exportLogs()}
          >
            <FileText className="h-4 w-4" />
            {t('settings.advanced.diagnostics.export')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
