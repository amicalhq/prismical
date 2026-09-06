'use client';

import type { WidgetVisibility } from '@prismical/app-contracts';
import { useDeviceSettings, useEntitlements } from '@prismical/app-client';
import { toast } from 'sonner';
import { Button } from '../../ui/button';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import { Switch } from '../../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { useTranslation } from 'react-i18next';

/**
 * The Dock settings section — replaces the single
 * meeting-widget row. Desktop-only: every control here drives the dock family
 * (pill / notification cards / floating note), which exists only in the native
 * app, so the whole section hides on web where `has("meeting-widget")` is
 * false. The auto-expand row gates individually on `floating-note`.
 *
 * The floating-note hotkey used to live here too; it moved to
 * Settings → Shortcuts so every shortcut in the app is on one screen.
 *
 * Reads/writes device settings live through useDeviceSettings — main's
 * settings-reactive fibers (visibility projection, hotkey registration,
 * content protection, dock reposition) apply each change immediately.
 */
export function DockSettings() {
  const { t } = useTranslation();
  const { settings, set, has } = useDeviceSettings();
  const { entitlements } = useEntitlements();
  if (!has('meeting-widget')) return null;
  // Floating mode is a plan feature as well as a desktop capability.
  const hasFloat = has('floating-note') && entitlements.features.floatingMode;

  return (
    <>
      <Separator />
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Label htmlFor="dock-visibility" className="text-base font-medium text-foreground">
            {t('settings.dock.visibility.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.dock.visibility.description')}
          </p>
        </div>
        <Select
          value={settings.widgetVisibility}
          onValueChange={value => set({ widgetVisibility: value as WidgetVisibility })}
        >
          <SelectTrigger id="dock-visibility" className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="never">{t('settings.dock.visibility.never')}</SelectItem>
            <SelectItem value="while-recording">
              {t('settings.dock.visibility.whileRecording')}
            </SelectItem>
            <SelectItem value="always">{t('settings.dock.visibility.always')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Label htmlFor="dock-notifications" className="text-base font-medium text-foreground">
            {t('settings.dock.notificationsLabel')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.dock.notificationsDescription')}
          </p>
        </div>
        <Switch
          id="dock-notifications"
          checked={settings.meetingNotifications}
          onCheckedChange={checked => set({ meetingNotifications: checked })}
        />
      </div>

      {hasFloat && (
        <>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="dock-auto-expand" className="text-base font-medium text-foreground">
                {t('settings.dock.autoExpandLabel')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.dock.autoExpandDescription')}
              </p>
            </div>
            <Switch
              id="dock-auto-expand"
              checked={settings.autoExpandOnRecording}
              onCheckedChange={checked => set({ autoExpandOnRecording: checked })}
            />
          </div>
        </>
      )}

      <Separator />
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Label
            htmlFor="dock-content-protection"
            className="text-base font-medium text-foreground"
          >
            {t('settings.dock.hideLabel')}
          </Label>
          <p className="text-xs text-muted-foreground">{t('settings.dock.hideDescription')}</p>
        </div>
        <Switch
          id="dock-content-protection"
          checked={settings.dockContentProtection}
          onCheckedChange={checked => set({ dockContentProtection: checked })}
        />
      </div>

      <Separator />
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Label className="text-base font-medium text-foreground">
            {t('settings.dock.resetLabel')}
          </Label>
          <p className="text-xs text-muted-foreground">{t('settings.dock.resetDescription')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void set({ dockAnchors: {}, dockDisplayId: null, floatNoteBounds: {} });
            toast.success(t('settings.dock.resetSuccess'));
          }}
        >
          {t('settings.dock.reset')}
        </Button>
      </div>
    </>
  );
}
