'use client';

import { useDesktopCapabilities } from '@prismical/app-client';
import { IconBrandApple, IconBrandWindows, IconBrandAndroid } from '@tabler/icons-react';
import { ChevronDown, Globe, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/dropdown-menu';

const DOWNLOAD_BASE = 'https://github.com/amicalhq/prismical/releases/latest/download';

export function OnboardingDownloadActions({ onContinue, compact = false }: { onContinue: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const isDesktop = useDesktopCapabilities().has('global-shortcuts');
  const ContinueIcon = isDesktop ? Monitor : Globe;

  return (
    <div className="flex w-full flex-col gap-3">
      <p className="text-center text-sm font-medium">
        {t(isDesktop ? 'onboarding.getMobileApp' : 'onboarding.downloadApps')}
      </p>
      <div className={`grid grid-cols-2 gap-3 ${isDesktop || compact ? '' : 'sm:grid-cols-4'}`}>
        {!isDesktop && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-11">
                  <IconBrandApple aria-hidden="true" />
                  {t('onboarding.platforms.mac')}
                  <ChevronDown aria-hidden="true" className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem asChild>
                  <a href={`${DOWNLOAD_BASE}/Prismical-macos-arm64.dmg`} target="_blank" rel="noreferrer">
                    {t('onboarding.macAppleSilicon')}
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={`${DOWNLOAD_BASE}/Prismical-macos-x64.dmg`} target="_blank" rel="noreferrer">
                    {t('onboarding.macIntel')}
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button asChild variant="outline" className="h-11">
              <a href={`${DOWNLOAD_BASE}/Prismical-windows-x64.exe`} target="_blank" rel="noreferrer">
                <IconBrandWindows aria-hidden="true" />
                {t('onboarding.platforms.windows')}
              </a>
            </Button>
          </>
        )}
        <Button asChild variant="outline" className="h-11">
          <a href="https://apps.apple.com/us/app/prismical-ai-note-taker/id6780624498" target="_blank" rel="noreferrer">
            <IconBrandApple aria-hidden="true" />
            {t('onboarding.platforms.ios')}
          </a>
        </Button>
        <Button asChild variant="outline" className="h-11">
          <a href="https://play.google.com/store/apps/details?id=ai.prismical.app" target="_blank" rel="noreferrer">
            <IconBrandAndroid aria-hidden="true" />
            {t('onboarding.platforms.android')}
          </a>
        </Button>
      </div>
      <Button className="w-full" onClick={onContinue}>
        <ContinueIcon aria-hidden="true" />
        {t(isDesktop ? 'onboarding.continueInDesktop' : 'onboarding.continueToWeb')}
      </Button>
    </div>
  );
}
