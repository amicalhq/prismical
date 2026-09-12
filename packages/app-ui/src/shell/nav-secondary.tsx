'use client';

import * as React from 'react';
import { BookText, Download, MessageSquare } from 'lucide-react';
import { useDesktopCapabilities } from '@prismical/app-client';
import { IconBrandDiscord } from '@tabler/icons-react';
import { SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '../ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../lib/utils';
import { useTranslation } from 'react-i18next';

// Secondary destinations are compact icon buttons that almost nobody
// clicks in a session, so they sit as one row of icon buttons rather than three
// full-width rows - the notes navigation above needs the vertical space more.
// The label each row used to show lives in the tooltip and the aria-label.
const secondaryLinks = [
  {
    id: 'docs',
    titleKey: 'navigation.secondary.docs',
    url: 'https://prismical.ai/docs',
    icon: BookText,
    external: true,
  },
  {
    id: 'community',
    titleKey: 'navigation.secondary.community',
    url: 'https://prismical.ai/community',
    icon: IconBrandDiscord,
    external: true,
  },
] as const;

export function NavSecondary({ supportAction, className, ...props }: React.ComponentProps<typeof SidebarGroup> & { supportAction?: React.ReactNode }) {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  return (
    <SidebarGroup className={cn('px-2 py-1', className)} {...props}>
      <SidebarGroupContent>
        <div className="flex items-center gap-1">
          {secondaryLinks.map(item => {
            const label = item.id === 'community' ? 'Discord' : t(item.titleKey);
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <a
                    href={item.url}
                    {...(item.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                    aria-label={label}
                    className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden"
                  >
                    <item.icon className="size-4" />
                  </a>
                </TooltipTrigger>
                <TooltipContent side="top">{label}</TooltipContent>
              </Tooltip>
            );
          })}
          {supportAction ?? (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href="mailto:help@prismical.ai"
                  aria-label={t('navigation.secondary.sendFeedback')}
                  className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden"
                >
                  <MessageSquare className="size-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent side="top">{t('navigation.secondary.feedback')}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {!caps.has('global-shortcuts') && (
          <SidebarMenu className="mt-1">
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="sm" className="text-sm text-sidebar-foreground">
                <a href="https://prismical.ai/apps" target="_blank" rel="noreferrer">
                  <Download aria-hidden="true" />
                  <span>{t('navigation.secondary.downloadApps')}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
