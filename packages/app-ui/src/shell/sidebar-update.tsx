'use client';

import * as React from 'react';
import { useDesktopCapabilities } from '@prismical/app-client';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '../ui/sidebar';
import { AppLink } from './app-link';

export function SidebarUpdate() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const enabled = caps.has('app-updates');
  const [staged, setStaged] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    let receivedUpdate = false;
    const off = caps.onUpdateState(view => {
      receivedUpdate = true;
      setStaged(view.staged);
    });
    void caps.getUpdateState().then(
      view => {
        // A live event takes precedence over an older startup snapshot.
        if (active && !receivedUpdate) setStaged(view.staged);
      },
      () => {
        // Keep listening if the initial snapshot could not be read.
      }
    );
    return () => {
      active = false;
      off();
    };
  }, [enabled, caps]);

  if (!enabled || !staged) return null;

  return (
    <SidebarMenu className="px-2 py-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
        >
          <AppLink href="/settings/about">
            <Download />
            <span>{t('settings.about.updates.sidebarCta')}</span>
          </AppLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
