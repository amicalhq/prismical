'use client';

import { useDesktopCapabilities } from '@prismical/app-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { Label } from '../../ui/label';
import { Button } from '../../ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../ui/alert-dialog';
import { useTranslation } from 'react-i18next';

/**
 * App reset. Desktop-only danger-zone Card, hidden on web
 * where `has('app-reset')` is false. Signs out all accounts, erases device data
 * and credentials, then relaunches into first-run setup after confirmation.
 * Server-side account data is kept.
 */
export function AppResetSetting() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  if (!caps.has('app-reset')) return null;

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">
          {t('settings.advanced.reset.dangerTitle')}
        </CardTitle>
        <CardDescription>{t('settings.advanced.reset.dangerDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-base font-medium text-foreground">
              {t('settings.advanced.reset.action')}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t('settings.advanced.reset.description')}
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">{t('settings.advanced.reset.action')}</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('settings.advanced.reset.confirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('settings.advanced.reset.confirm')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.actions.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => void caps.resetApp()}
                >
                  {t('settings.advanced.reset.restart')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
