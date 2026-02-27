import * as React from "react";
import {
  IconBookFilled,
  IconBrandDiscordFilled,
  IconChevronLeft,
  IconInfoCircle,
} from "@tabler/icons-react";
import { Link, useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { NavMain } from "@/components/nav-main";
import {
  NavSecondary,
  type NavSecondaryItem,
} from "@/components/nav-secondary";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import {
  parseSidebarCtaPayload,
  SIDEBAR_CTA_FEATURE_FLAG,
} from "@/utils/feature-flags";
import { api } from "@/trpc/react";
import { CommandSearchButton } from "./command-search-button";
import { CreateNoteButton } from "./create-note-button";
import { NavNotesGroups } from "./nav-notes-groups";
import { HOME_NAV_ITEMS, SETTINGS_NAV_ITEMS } from "../lib/settings-navigation";

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const location = useLocation();
  const sidebarCtaFlag = useFeatureFlag(SIDEBAR_CTA_FEATURE_FLAG);
  const isHomeSidebar =
    location.pathname.startsWith("/settings/home") ||
    location.pathname.startsWith("/settings/notes") ||
    location.pathname.startsWith("/settings/events");

  const sidebarCtaPayload = sidebarCtaFlag.enabled
    ? parseSidebarCtaPayload(sidebarCtaFlag.payload)
    : null;

  const { data: notesForGroups = [] } = api.notes.getNotes.useQuery(
    {
      limit: 500,
      sortBy: "updatedAt",
      sortOrder: "desc",
    },
    {
      enabled: isHomeSidebar,
    },
  );

  const isMac =
    typeof window !== "undefined" && window.electronAPI?.platform === "darwin";
  const homeHeaderNav = HOME_NAV_ITEMS.map(({ titleKey, url, icon, shortcutKey }) => ({
    title: t(titleKey),
    url,
    icon: typeof icon === "string" ? undefined : icon,
    shortcut: shortcutKey
      ? isMac
        ? `⌘ ${shortcutKey}`
        : `Ctrl+${shortcutKey}`
      : undefined,
  }));
  const homeNavItem = homeHeaderNav.find((item) => item.url === "/settings/home");
  const settingsNavItem = homeHeaderNav.find(
    (item) => item.url === "/settings/preferences",
  );
  const navMain = SETTINGS_NAV_ITEMS.map(({ titleKey, url, icon, shortcutKey }) => ({
    title: t(titleKey),
    url,
    icon: typeof icon === "string" ? undefined : icon,
    shortcut: shortcutKey
      ? isMac
        ? `⌘ ${shortcutKey}`
        : `Ctrl+${shortcutKey}`
      : undefined,
  }));

  const baseNavSecondary: NavSecondaryItem[] = [
    {
      id: "docs",
      title: t("settings.sidebar.docs"),
      url: "https://amical.ai/docs",
      icon: IconBookFilled,
    },
    {
      id: "community",
      title: t("settings.sidebar.community"),
      url: "https://amical.ai/community",
      icon: IconBrandDiscordFilled,
    },
  ];

  const navSecondaryCta: NavSecondaryItem | null = sidebarCtaPayload
    ? {
        id: "sidebar-cta",
        title: sidebarCtaPayload.text,
        url: sidebarCtaPayload.url,
        icon: IconInfoCircle,
        ctaStyle: {
          palette: sidebarCtaPayload.palette,
          style: sidebarCtaPayload.style,
          emoji: sidebarCtaPayload.emoji,
        },
      }
    : null;

  const navSecondary: NavSecondaryItem[] = navSecondaryCta
    ? [navSecondaryCta, ...baseNavSecondary]
    : baseNavSecondary;

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <div
        className="h-[var(--titlebar-height)] shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      {isHomeSidebar ? (
        <SidebarHeader className="py-0 -mb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="data-[slot=sidebar-menu-button]:!p-1.5"
              >
                <div className="inline-flex items-center gap-2.5 font-semibold w-full">
                  <img
                    src="assets/logo.svg"
                    alt={t("settings.sidebar.logoAlt")}
                    className="!size-7"
                  />
                  <span className="font-semibold">
                    {t("settings.sidebar.brand")}
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <CreateNoteButton />
            </SidebarMenuItem>
            {homeNavItem ? (
              <SidebarMenuItem key={homeNavItem.url}>
                <SidebarMenuButton
                  asChild
                  isActive={location.pathname.startsWith(homeNavItem.url)}
                >
                  <Link
                    to={homeNavItem.url}
                    aria-label={homeNavItem.title}
                    activeProps={{ className: "active" }}
                  >
                    {homeNavItem.icon && <homeNavItem.icon />}{" "}
                    <span>{homeNavItem.title}</span>
                    {homeNavItem.shortcut && (
                      <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground ml-auto">
                        {homeNavItem.shortcut}
                      </kbd>
                    )}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
            <SidebarMenuItem>
              <CommandSearchButton />
            </SidebarMenuItem>
            {settingsNavItem ? (
              <SidebarMenuItem key={settingsNavItem.url}>
                <SidebarMenuButton
                  asChild
                  isActive={location.pathname.startsWith(settingsNavItem.url)}
                >
                  <Link
                    to={settingsNavItem.url}
                    aria-label={settingsNavItem.title}
                    activeProps={{ className: "active" }}
                  >
                    {settingsNavItem.icon && <settingsNavItem.icon />}{" "}
                    <span>{settingsNavItem.title}</span>
                    {settingsNavItem.shortcut && (
                      <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground ml-auto">
                        {settingsNavItem.shortcut}
                      </kbd>
                    )}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarHeader>
      ) : (
        <SidebarHeader className="py-0 -mb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="data-[slot=sidebar-menu-button]:!p-1.5"
              >
                <Link
                  to="/settings/home"
                  aria-label={t("settings.sidebar.backToHome")}
                >
                  <IconChevronLeft />
                  <span>{t("settings.sidebar.backToHome")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <div className="inline-flex items-center gap-2.5 w-full px-2 py-1.5 font-semibold">
                {t("menu.settings")}
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
      )}
      <SidebarContent>
        {!isHomeSidebar ? <NavMain items={navMain} /> : null}
        {isHomeSidebar ? <NavNotesGroups notes={notesForGroups} /> : null}
        <NavSecondary items={navSecondary} className="mt-auto" />
      </SidebarContent>
    </Sidebar>
  );
}
