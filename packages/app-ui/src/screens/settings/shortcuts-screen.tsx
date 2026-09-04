'use client';

import { useDeviceSettings } from '@prismical/app-client';
import { Card, CardContent } from '../../ui/card';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import {
  SHORTCUTS,
  shortcutChips,
  useIsApplePlatform,
  type ShortcutCategory,
  type ShortcutId,
} from '../../lib/shortcuts';
import { HotkeyRecorder } from './hotkey-recorder';
import { Kbd, KbdGroup } from '../../ui/kbd';
import { useTranslation } from 'react-i18next';

// Settings → Shortcuts. Rendered straight off the shortcuts
// registry that the bindings themselves register into (lib/shortcuts.ts), so
// this list is the real one — it used to be mock data that matched nothing.
//
// This screen is the ONE place shortcuts live, which is the point of the
// ticket: the floating-note hotkey recorder moved here out of Preferences →
// Dock rather than being mirrored read-only in two screens.
//
// Scope note: the in-app rows stay read-only. Rebinding those is a separate,
// larger feature (persisted overrides + conflict detection across the
// registry); the floating-note hotkey is rebindable because it already had a
// working recorder and a settings field behind it.

// Keyed by category rather than a bare array so adding a ShortcutCategory is a
// type error here instead of silently dropping that category off the screen.
const CATEGORY_RANK: Record<ShortcutCategory, number> = {
  General: 0,
  Navigation: 1,
};
const CATEGORY_ORDER = (Object.keys(CATEGORY_RANK) as ShortcutCategory[]).sort(
  (a, b) => CATEGORY_RANK[a] - CATEGORY_RANK[b]
);

function ShortcutRow({ action, keys }: { action: string; keys: string[] }) {
  return (
    <li className="flex items-center justify-between py-2">
      <span className="text-sm text-foreground">{action}</span>
      <KbdGroup>
        {keys.map((key, index) => (
          <Kbd key={`${key}-${index}`}>{key}</Kbd>
        ))}
      </KbdGroup>
    </li>
  );
}

export function ShortcutsScreen() {
  const { t } = useTranslation();
  const isApple = useIsApplePlatform();
  const { settings, set, has } = useDeviceSettings();

  // The floating-note hotkey is an OS-level global registered by Electron main,
  // not one of the in-app bindings — shown only where it actually exists. Note
  // the gate does NOT test for a non-empty accelerator: this is now the only
  // place to set it, so a disabled hotkey must still render (as "Disabled") or
  // it could never be turned back on.
  const showDockHotkey = has('floating-note') && has('global-shortcuts');
  const actionLabels: Record<ShortcutId, string> = {
    'command-palette': t('settings.shortcuts.actions.commandPalette'),
    'toggle-sidebar': t('settings.shortcuts.actions.toggleSidebar'),
    'go-home': t('settings.shortcuts.actions.goHome'),
    'go-settings': t('settings.shortcuts.actions.goSettings'),
  };
  const categoryLabels: Record<ShortcutCategory, string> = {
    General: t('settings.shortcuts.categories.general'),
    Navigation: t('settings.shortcuts.categories.navigation'),
  };

  // Only list what's actually bound on this platform. `desktopOnly` entries
  // aren't registered where global shortcuts are unsupported (see
  // shell/nav-shortcuts.tsx and the sidebar's enableKeyboardShortcut), and a
  // screen that advertises an unbound key is the exact drift this screen exists
  // to prevent.
  const visible = SHORTCUTS.filter(shortcut => !shortcut.desktopOnly || has('global-shortcuts'));

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('settings.shortcuts.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('settings.shortcuts.description')}</p>
      </div>

      {/* Global shortcuts lead: they're the rebindable ones, so they're what
          you come to this screen to change. The in-app list below is reference. */}
      <div className="space-y-6">
        {showDockHotkey && (
          <Card>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-base font-semibold text-foreground">
                  {t('settings.shortcuts.global.title')}
                </Label>
                <p className="text-xs text-muted-foreground mt-1 max-w-md">
                  {t('settings.shortcuts.global.description')}
                </p>
              </div>
              <Separator />
              <div className="flex items-center justify-between py-2">
                <div className="space-y-1">
                  <Label htmlFor="dock-hotkey" className="text-sm font-normal text-foreground">
                    {t('settings.shortcuts.global.floatingNote')}
                  </Label>
                </div>
                <HotkeyRecorder
                  id="dock-hotkey"
                  value={settings.dockHotkey}
                  // This card only renders on desktop (gate above), so the mac
                  // window chrome capability doubles as the darwin signal for
                  // accelerator naming.
                  isMac={has('window-chrome-mac')}
                  label={t('settings.shortcuts.global.recordAria')}
                  onChange={accelerator => set({ dockHotkey: accelerator })}
                />
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-base font-semibold text-foreground">
                {t('settings.shortcuts.inApp.title')}
              </Label>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">
                {t('settings.shortcuts.inApp.description')}
              </p>
            </div>
            {CATEGORY_ORDER.map(category => {
              const inCategory = visible.filter(shortcut => shortcut.category === category);
              if (inCategory.length === 0) return null;
              return (
                <div key={category} className="space-y-2">
                  <Separator />
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {categoryLabels[category]}
                  </p>
                  <ul className="divide-y divide-border">
                    {inCategory.map(shortcut => (
                      <ShortcutRow
                        key={shortcut.id}
                        action={actionLabels[shortcut.id]}
                        keys={shortcutChips(shortcut, isApple)}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
