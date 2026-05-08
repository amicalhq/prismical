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
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import {
  parseSidebarCtaPayload,
  SIDEBAR_CTA_FEATURE_FLAG,
} from "@/utils/feature-flags";
import { api } from "@/trpc/react";
import { CommandSearchButton } from "./command-search-button";
import { NavNotesGroups } from "./nav-notes-groups";
import { SettingsNavigationControls } from "./settings-navigation-controls";
import { HOME_NAV_ITEMS, SETTINGS_NAV_ITEMS } from "../lib/settings-navigation";

const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragRegion = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const sidebarCtaFlag = useFeatureFlag(SIDEBAR_CTA_FEATURE_FLAG);
  const isAppSidebar =
    location.pathname.startsWith("/home") ||
    location.pathname.startsWith("/notes") ||
    location.pathname.startsWith("/events") ||
    location.pathname.startsWith("/tags");
  const showNotesNavigation =
    location.pathname.startsWith("/home") ||
    location.pathname.startsWith("/notes") ||
    location.pathname.startsWith("/tags");

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
      enabled: showNotesNavigation,
    },
  );

  const isMac =
    typeof window !== "undefined" && window.electronAPI?.platform === "darwin";

  const [modifierPressed, setModifierPressed] = React.useState(false);
  React.useEffect(() => {
    const isModifier = (e: KeyboardEvent) =>
      isMac ? e.key === "Meta" : e.key === "Control";
    const onKeyDown = (e: KeyboardEvent) => {
      if (isModifier(e)) setModifierPressed(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isModifier(e)) setModifierPressed(false);
    };
    const onBlur = () => setModifierPressed(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [isMac]);
  const homeHeaderNav = HOME_NAV_ITEMS.map(
    ({ titleKey, url, icon, shortcutKey }) => ({
      title: t(titleKey),
      url,
      icon: typeof icon === "string" ? undefined : icon,
      shortcut: shortcutKey
        ? isMac
          ? `⌘ ${shortcutKey}`
          : `Ctrl+${shortcutKey}`
        : undefined,
    }),
  );
  const primaryNavItems = homeHeaderNav.filter(
    (item) => item.url !== "/settings/preferences",
  );
  const settingsNavItem = homeHeaderNav.find(
    (item) => item.url === "/settings/preferences",
  );
  const navMain = SETTINGS_NAV_ITEMS.map(
    ({ titleKey, url, icon, shortcutKey }) => ({
      title: t(titleKey),
      url,
      icon: typeof icon === "string" ? undefined : icon,
      shortcut: shortcutKey
        ? isMac
          ? `⌘ ${shortcutKey}`
          : `Ctrl+${shortcutKey}`
        : undefined,
    }),
  );

  const baseNavSecondary: NavSecondaryItem[] = [
    {
      id: "docs",
      title: t("settings.sidebar.docs"),
      url: "https://prismical.ai/docs",
      icon: IconBookFilled,
    },
    {
      id: "community",
      title: t("settings.sidebar.community"),
      url: "https://prismical.ai/community",
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
        className="relative h-[var(--titlebar-height)] shrink-0"
        style={dragRegion}
      >
        {isMobile ? (
          <SettingsNavigationControls
            className="absolute top-2.5"
            interactiveStyle={noDragRegion}
            style={{ ...noDragRegion, left: "var(--toolbar-left)" }}
          />
        ) : null}
      </div>
      {isAppSidebar ? (
        <SidebarHeader className="py-0 mb-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className="data-[slot=sidebar-menu-button]:!p-1.5"
              >
                <div className="inline-flex items-center gap-2.5 font-semibold w-full">
                  <img
                    src="/assets/app-icon.png"
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
              <CommandSearchButton />
            </SidebarMenuItem>
            {primaryNavItems.map((item) => (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton
                  asChild
                  isActive={location.pathname.startsWith(item.url)}
                >
                  <Link
                    to={item.url}
                    aria-label={item.title}
                    activeProps={{ className: "active" }}
                  >
                    {item.icon && <item.icon />} <span>{item.title}</span>
                    {item.shortcut && (
                      <kbd
                        className={`pointer-events-none ml-auto inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground transition-opacity ${
                          modifierPressed ? "opacity-100" : "opacity-0"
                        }`}
                      >
                        {item.shortcut}
                      </kbd>
                    )}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
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
                      <kbd
                        className={`pointer-events-none ml-auto inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground transition-opacity ${
                          modifierPressed ? "opacity-100" : "opacity-0"
                        }`}
                      >
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
                <Link to="/home" aria-label={t("settings.sidebar.backToHome")}>
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
        {!isAppSidebar ? <NavMain items={navMain} /> : null}
        {showNotesNavigation ? <NavNotesGroups notes={notesForGroups} /> : null}
      </SidebarContent>
      <SidebarFooter className="p-0">
        <NavSecondary items={navSecondary} />
      </SidebarFooter>
    </Sidebar>
  );
}
