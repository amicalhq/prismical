'use client';

import * as React from 'react';
import { BookText, MessageCircle, MessageSquare } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '../ui/sidebar';
import { useTranslation } from 'react-i18next';

const secondaryLinks = [
  {
    id: 'docs',
    titleKey: 'navigation.secondary.docs',
    url: 'https://prismical.ai/docs',
    icon: BookText,
  },
  {
    id: 'community',
    titleKey: 'navigation.secondary.community',
    url: 'https://prismical.ai/community',
    icon: MessageCircle,
  },
] as const;

// TEMPORARILY removed until the desktop app is tested (revert this commit to restore):
// the web-only "Get the apps" link (https://prismical.ai/apps, gated off desktop via
// useDesktopCapabilities().has("global-shortcuts")).

export function NavSecondary({ ...props }: React.ComponentProps<typeof SidebarGroup>) {
  const { t } = useTranslation();
  const links = secondaryLinks;
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {links.map(item => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton asChild size="sm" className="text-sm text-sidebar-foreground">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t(item.titleKey as never)}
                >
                  <item.icon className="size-4" />
                  <span>{t(item.titleKey as never)}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="sm" className="text-sm text-sidebar-foreground">
              <a
                href="mailto:feedback@prismical.ai"
                aria-label={t('navigation.secondary.sendFeedback')}
              >
                <MessageSquare className="size-4" />
                <span>{t('navigation.secondary.feedback')}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
