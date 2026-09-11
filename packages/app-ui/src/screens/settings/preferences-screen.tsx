'use client';

import { Card, CardContent } from '../../ui/card';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Separator } from '../../ui/separator';
import { useDesktopCapabilities, useRecordingPreferences } from '@prismical/app-client';
import { ThemeToggle } from './theme-toggle';
import { OrganizationDangerZone } from './organization-danger-zone';
import { AutoEnhanceToggle } from './auto-enhance-toggle';
import { DockSettings } from './dock-settings';
import { LaunchAtLoginSetting } from './launch-at-login-setting';
import { PermissionsSetting } from './permissions-setting';
import { AiOutputLanguageSetting } from './ai-output-language-setting';
import { InterfaceLanguageSetting } from './interface-language-setting';
import { useTranslation } from 'react-i18next';

function AutoTranscribeToggle() {
  const { t } = useTranslation();
  const isDesktop = useDesktopCapabilities().has('global-shortcuts');
  const [preferences, setPreferences] = useRecordingPreferences();

  if (isDesktop) return null;

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Label htmlFor="auto-transcribe" className="text-base font-medium text-foreground">
            {t('settings.preferences.autoTranscribe.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.preferences.autoTranscribe.description')}
          </p>
        </div>
        <Switch
          id="auto-transcribe"
          checked={preferences.autoTranscribeNewNotes}
          onCheckedChange={on => setPreferences({ autoTranscribeNewNotes: on })}
        />
      </div>
      <Separator />
    </>
  );
}

export function PreferencesScreen() {
  const { t } = useTranslation();

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('settings.preferences.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('settings.preferences.description')}
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4">
            {/* Launch at login — desktop-only; the component
                owns its trailing separator and renders nothing on web. */}
            <LaunchAtLoginSetting />

            <AutoTranscribeToggle />

            {/* Auto-enhance after recording — the one wired preference here. */}
            <AutoEnhanceToggle />

            {/* The Dock section — desktop-only; the component
                owns its leading separators and renders nothing on web. */}
            <DockSettings />

            <Separator />

            <InterfaceLanguageSetting />

            <Separator />

            <AiOutputLanguageSetting />

            <Separator />

            {/* Theme */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  {t('settings.preferences.theme.label')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.preferences.theme.description')}
                </p>
              </div>
              <ThemeToggle />
            </div>
          </CardContent>
        </Card>

        {/* Native OS permissions — desktop-only Card, hidden
            on web where has('mic-devices') is false. */}
        <PermissionsSetting />

        {/* Owner-only: request organization deletion (manual, via email). */}
        <OrganizationDangerZone />
      </div>
    </div>
  );
}
