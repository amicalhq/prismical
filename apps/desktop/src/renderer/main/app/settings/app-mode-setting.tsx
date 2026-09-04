/**
 * The app-mode switch card is desktop-owned and slotted into the shared
 * AdvancedScreen through its `modeSettings` prop
 * and gated on the `app-mode` capability; it never reaches the shared
 * library. Being desktop-owned it may read the mode (useDesktopEnv).
 *
 * The switch IS the destructive reset (capability:resetApp with a target
 * mode): main signs every account out, clears the device state, writes the
 * new mode and relaunches; the next boot purges the product stores, models
 * and recovery WAVs before anything opens them. The confirm dialog states
 * exactly that. The renderer severs its analytics identity FIRST, as the
 * shared reset card does.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopCapabilities } from '@prismical/app-client';
import type { AppModeValue } from '@prismical/desktop-contracts';
import { Button } from '@prismical/app-ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@prismical/app-ui/ui/card';
import { Label } from '@prismical/app-ui/ui/label';
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
} from '@prismical/app-ui/ui/alert-dialog';
import { resetAnalyticsIdentity } from '../analytics/posthog';
import { useDesktopEnv } from '../desktop-env';

export function AppModeSetting() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const { appMode } = useDesktopEnv();
  const [busy, setBusy] = useState(false);
  if (!caps.has('app-mode')) return null;

  const target: AppModeValue = appMode === 'local' ? 'cloud' : 'local';
  const switchLabel =
    target === 'local' ? t('desktop.modeSwitch.switchToLocal') : t('desktop.modeSwitch.switchToCloud');

  const switchMode = (): void => {
    if (busy) return;
    setBusy(true);
    // Sever the renderer analytics identity FIRST; main then wipes storage,
    // regenerates the telemetry device id and relaunches (a switched install
    // must not be joinable to the prior identity).
    resetAnalyticsIdentity();
    // Main relaunches, so the invoke may never resolve; a rejection is logged
    // by the preload/port lane and the user can retry.
    window.desktop.capabilities.resetApp({ mode: target }).catch(() => {
      setBusy(false);
    });
  };

  return (
    <Card data-testid="app-mode" data-mode={appMode}>
      <CardHeader>
        <CardTitle>{t('desktop.modeSwitch.title')}</CardTitle>
        <CardDescription>{t('desktop.modeSwitch.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-base font-medium text-foreground">
              {appMode === 'local'
                ? t('desktop.modeSwitch.current.local')
                : t('desktop.modeSwitch.current.cloud')}
            </Label>
            <p className="text-sm text-muted-foreground">{switchLabel}</p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" data-testid="app-mode-switch" disabled={busy}>
                {switchLabel}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent data-testid="app-mode-confirm">
              <AlertDialogHeader>
                <AlertDialogTitle>{t('desktop.modeSwitch.confirm.title')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('desktop.modeSwitch.confirm.description')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.actions.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="app-mode-confirm-action"
                  onClick={switchMode}
                >
                  {t('desktop.modeSwitch.confirm.action')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
