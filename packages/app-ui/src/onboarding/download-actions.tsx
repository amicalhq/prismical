'use client';

import { useDesktopCapabilities } from '@prismical/app-client';
import { IconBrandApple, IconBrandWindows, IconBrandAndroid } from '@tabler/icons-react';
import { ChevronDown, Globe, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';

const DOWNLOAD_BASE = 'https://github.com/amicalhq/prismical/releases/latest/download';

/**
 * Just the per-platform download buttons, with no surrounding heading or call to action.
 *
 * `size` picks the row's proportions: 'comfortable' is the tall two-column grid the guided tour
 * has always shown, 'compact' is a single short row that leaves the vertical space to whatever
 * sits above it. Desktop drops the desktop builds either way - you are already in the app - which
 * is what lets the compact row stay on one line on a phone as well.
 */
export function OnboardingDownloadButtons({
  size = 'comfortable',
  columns,
  accent = false,
}: {
  size?: 'comfortable' | 'compact';
  columns?: boolean;
  /** Tint the row with the product accent so it reads as an action, not as chrome. */
  accent?: boolean;
}) {
  const { t } = useTranslation();
  const isDesktop = useDesktopCapabilities().has('global-shortcuts');
  const small = size === 'compact';
  // No `px-*` here: the Button's own `has-[>svg]:px-3` outranks it, and every one of these
  // carries an icon. The icon selector must match the base's `:not([class*='size-'])` shape or it
  // loses to it and silently resizes only the chevron.
  const button = small ? 'h-9 text-xs' : 'h-11';
  const icon = small ? "[&_svg:not([class*='size-'])]:size-3.5" : '';
  // Tinted rather than solid: four filled buttons in a row would compete with each other and with
  // the video above them. Both themes get their own foreground so the label keeps its contrast.
  // The dark variants are not optional: the outline button carries `dark:bg-input/30` and
  // `dark:border-input`, which outrank an un-prefixed tint, so without these the row loses its
  // accent entirely in dark mode and reads as plain grey.
  const tint = accent
    ? 'border-indigo-400/40 bg-indigo-500/5 text-indigo-700 hover:border-indigo-400/60 hover:bg-indigo-500/10 hover:text-indigo-700 dark:border-indigo-400/30 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:border-indigo-400/50 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200'
    : '';

  return (
    <div
      className={
        small
          ? // A grid, not a wrapping flex row: with `flex-1` a fourth button that wraps alone
            // stretches to the full width, which is what a 432-551px viewport produces. Columns
            // keep it 2+2 on a phone and one row from `sm` up.
            `grid w-full grid-cols-2 gap-2 ${isDesktop ? 'sm:grid-cols-2' : 'sm:grid-cols-4'}`
          : `grid grid-cols-2 gap-3 ${isDesktop || columns ? '' : 'sm:grid-cols-4'}`
      }
    >
      {!isDesktop && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className={`${button} ${icon} ${tint}`}>
                <IconBrandApple aria-hidden="true" />
                {t('onboarding.platforms.mac')}
                <ChevronDown aria-hidden="true" className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem asChild>
                <a
                  href={`${DOWNLOAD_BASE}/Prismical-macos-arm64.dmg`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('onboarding.macAppleSilicon')}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href={`${DOWNLOAD_BASE}/Prismical-macos-x64.dmg`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('onboarding.macIntel')}
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button asChild variant="outline" className={`${button} ${icon} ${tint}`}>
            <a href={`${DOWNLOAD_BASE}/Prismical-windows-x64.exe`} target="_blank" rel="noreferrer">
              <IconBrandWindows aria-hidden="true" />
              {t('onboarding.platforms.windows')}
            </a>
          </Button>
        </>
      )}
      <Button asChild variant="outline" className={`${button} ${icon} ${tint}`}>
        <a
          href="https://apps.apple.com/us/app/prismical-ai-note-taker/id6780624498"
          target="_blank"
          rel="noreferrer"
        >
          <IconBrandApple aria-hidden="true" />
          {t('onboarding.platforms.ios')}
        </a>
      </Button>
      <Button asChild variant="outline" className={`${button} ${icon} ${tint}`}>
        <a
          href="https://play.google.com/store/apps/details?id=ai.prismical.app"
          target="_blank"
          rel="noreferrer"
        >
          <IconBrandAndroid aria-hidden="true" />
          {t('onboarding.platforms.android')}
        </a>
      </Button>
    </div>
  );
}

export function OnboardingDownloadActions({
  onContinue,
  compact = false,
}: {
  onContinue: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const isDesktop = useDesktopCapabilities().has('global-shortcuts');
  const ContinueIcon = isDesktop ? Monitor : Globe;

  return (
    <div className="flex w-full flex-col gap-3">
      <p className="text-center text-sm font-medium">
        {t(isDesktop ? 'onboarding.getMobileApp' : 'onboarding.downloadApps')}
      </p>
      <OnboardingDownloadButtons columns={compact} />
      <Button className="w-full" onClick={onContinue}>
        <ContinueIcon aria-hidden="true" />
        {t(isDesktop ? 'onboarding.continueInDesktop' : 'onboarding.continueToWeb')}
      </Button>
    </div>
  );
}
