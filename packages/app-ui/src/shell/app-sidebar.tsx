'use client';

import * as React from 'react';
import { AppLink as Link } from './app-link';
import { SidebarNavigation } from './sidebar-navigation';
import {
  usePathname,
  useSearchParams,
  usePorts,
  useDesktopCapabilities,
  useActiveOrgId,
  useOrganizations,
  useFeatureFlags,
} from '@prismical/app-client';
import { ChevronLeft, Contact, Users } from 'lucide-react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '../ui/sidebar';
import { CommandPaletteTrigger } from './command-palette';
import { NavNotesGroups } from './nav-notes-groups';
import { NavSecondary } from './nav-secondary';
import { FirstNoteWalkthroughReplay } from '../onboarding/first-note-walkthrough';
import { CtaSidebarButton } from './cta';
import { SidebarQuota } from './sidebar-quota';
import { SidebarUpdate } from './sidebar-update';
import { useHomeNavItems, useSettingsNavItems } from './sidebar-nav';
import { SettingsNavigation } from './settings-navigation';
import { ShortcutHint } from './shortcut-hint';
import { useTranslation } from 'react-i18next';

// Faithful port of the desktop `SettingsSidebar`: a single sidebar that flips
// between "app mode" (brand + search + primary nav + Favorites/Folders/Tags)
// and "settings mode" (back-to-home + the settings nav list).

export function AppSidebar({
  accountSwitcher,
  supportAction,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  // The footer account/org switcher. Provided by the platform shell (web: the
  // AuthButton over the web AuthProvider; desktop supplies its own) since
  // it drives platform-specific auth actions (add-account, sign-out) that live
  // outside the sanitized AuthPort.
  accountSwitcher?: React.ReactNode;
  supportAction?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const homeNavItems = useHomeNavItems();
  const allSettingsNavItems = useSettingsNavItems();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { assets } = usePorts();
  const caps = useDesktopCapabilities();
  const activeOrgId = useActiveOrgId();
  const { data: organizations } = useOrganizations();
  // Cloud-only surfaces hide behind org feature flags — never
  // an app-mode branch. Nav reads `enabled` only; a hidden-then-shown link is
  // harmless, and the screens gate themselves.
  const features = useFeatureFlags();
  const { isMobile, setOpenMobile } = useSidebar();
  // Desktop frameless chrome (mac: hiddenInset traffic lights; Windows:
  // titleBarOverlay caption buttons). The DesktopChromeStrip is a fixed top-0
  // drag band over the window's top 40px, so the sidebar reserves the same 40px
  // above its header to keep the brand out from under that band — otherwise the
  // brand is overlapped AND draggable-not-clickable (Windows lacked this spacer;
  // mac already had it). Never on web (capability false) or the mobile sheet
  // (the band is window-anchored, not sheet-anchored).
  const desktopChromeSpacer =
    (caps.has('window-chrome-mac') || caps.has('window-chrome-windows')) && !isMobile;

  const isAppSidebar =
    pathname.startsWith('/home') ||
    pathname.startsWith('/notes') ||
    pathname.startsWith('/folders') ||
    pathname.startsWith('/tags') ||
    pathname.startsWith('/shared') ||
    pathname.startsWith('/events') ||
    pathname.startsWith('/people') ||
    pathname.startsWith('/companies');
  // The "Notes" primary item only highlights on the unfiltered browser — an
  // active folder/tag row in the groups below should otherwise own the
  // selection.
  const isAllNotesView =
    pathname === '/notes' &&
    !searchParams.get('folder') &&
    searchParams.getAll('tags').length === 0;

  // Keyboard shortcuts are a desktop-only feature. Where global
  // shortcuts aren't supported (web) we hide the Shortcuts settings nav entry
  // AND strip the ⌘-hint chips (⌘H on Home, ⌘, on Settings). Those combos ARE
  // bound (shell/nav-shortcuts.tsx) but only fire per-platform on web (browsers
  // reserve ⌘,, macOS reserves ⌘H), so a chip would advertise something that
  // may not work — only ⌘K keeps its chip. Desktop reports every capability and
  // keeps the entry + chips. (Reuses `caps` from the mac-chrome check above.)
  const shortcutsSupported = caps.has('global-shortcuts');
  const activeOrganization = organizations?.find(
    organization => organization.orgId === activeOrgId
  );
  const canManageBilling =
    activeOrganization?.role === 'owner' || activeOrganization?.role === 'admin';

  const primaryNavItems = homeNavItems
    .filter(item => item.url !== '/settings/preferences')
    .map(item => (shortcutsSupported ? item : { ...item, shortcut: undefined }));
  const settingsNavItemBase = homeNavItems.find(item => item.url === '/settings/preferences');
  const settingsNavItem =
    settingsNavItemBase && !shortcutsSupported
      ? { ...settingsNavItemBase, shortcut: undefined }
      : settingsNavItemBase;

  // Shortcuts and Advanced are desktop-only (above). Billing is role-gated on
  // both platforms; desktop mounts a secure handoff instead of the web checkout.
  // Members USED to be hidden on desktop too, but the screen has been mounted on
  // desktop's router all along and the shared AccountSwitcher now links straight
  // to it — an entry the sidebar hid would have been the only way in.
  const settingsNavItems = allSettingsNavItems.filter(item => {
    if (item.url === '/settings/shortcuts') return shortcutsSupported;
    if (item.url === '/settings/advanced') return shortcutsSupported;
    // The local whisper model manager — a named capability,
    // never an app-mode branch: desktop answers true in both modes.
    if (item.url === '/settings/local-models') return caps.has('local-models');
    if (item.url === '/settings/billing') {
      return canManageBilling && features.isEnabled('billing');
    }
    return item.feature ? features.isEnabled(item.feature) : true;
  });

  return (
    <SidebarNavigation>
    <Sidebar collapsible="offcanvas" {...props}>
      {desktopChromeSpacer ? <div className="h-10 shrink-0 [-webkit-app-region:drag]" /> : null}
      {isAppSidebar ? (
        <SidebarHeader className="py-0 mb-2">
          <SidebarMenu>
            {/* Brand */}
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
                <div className="inline-flex w-full items-center gap-2.5 font-semibold">
                  {/* Fixed-size brand mark from /public, resolved through the
                      AssetPort so desktop can rebase the prismical-app:// scheme. */}
                  <img
                    src={assets.resolve('/prismical-icon.svg')}
                    alt="Prismical"
                    className="size-7"
                  />
                  <span className="font-brand text-base font-medium text-primary">Prismical</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>

            {/* Command search */}
            <SidebarMenuItem>
              <CommandPaletteTrigger />
            </SidebarMenuItem>

            {/* Primary nav: Home, Notes */}
            {primaryNavItems.map(item => (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="text-sm text-sidebar-foreground"
                  isActive={item.url === '/notes' ? isAllNotesView : pathname === item.url}
                >
                  <Link href={item.url} aria-label={item.title}>
                    <item.icon /> <span>{item.title}</span>
                    {item.shortcut && <ShortcutHint shortcut={item.shortcut} />}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}

            {/* People & Companies directory — one entry, the page has a
                [People | Companies] toggle. Available to every cloud org;
                an accountless platform can omit it from its feature table. */}
            {(caps.featureFlags === null || caps.featureFlags.directory === true) && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="text-sm text-sidebar-foreground"
                  isActive={pathname.startsWith('/people') || pathname.startsWith('/companies')}
                >
                  <Link href="/people" aria-label={t('navigation.pages.people')}>
                    <Contact /> <span>{t('navigation.pages.people')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}

            {/* Shared with me */}
            {features.isEnabled('sharing') && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="text-sm text-sidebar-foreground"
                  isActive={pathname.startsWith('/shared')}
                >
                  <Link href="/shared" aria-label={t('navigation.pages.sharedWithMe')}>
                    <Users /> <span>{t('navigation.pages.sharedWithMe')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}

            {/* Settings */}
            {settingsNavItem && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="text-sm text-sidebar-foreground"
                  isActive={pathname === settingsNavItem.url}
                >
                  <Link href={settingsNavItem.url} aria-label={settingsNavItem.title}>
                    <settingsNavItem.icon /> <span>{settingsNavItem.title}</span>
                    {settingsNavItem.shortcut && (
                      <ShortcutHint shortcut={settingsNavItem.shortcut} />
                    )}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarHeader>
      ) : (
        <SidebarHeader className="py-0 -mb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                size="sm"
                className="text-sm text-sidebar-foreground data-[slot=sidebar-menu-button]:!p-1.5"
              >
                <Link href="/home" aria-label={t('navigation.backToHome')}>
                  <ChevronLeft />
                  <span>{t('navigation.backToHome')}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <div className="inline-flex w-full items-center gap-2.5 px-2 py-1.5 font-semibold">
                {t('navigation.pages.settings')}
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
      )}

      <SidebarContent>
        {/* Two modes, not three: settings shows the settings nav, and every app
            route shows the Favorites/Folders/Tags tree. The tree used to be
            gated to /home, /notes and /shared, so navigating to People,
            Companies or Events silently emptied the sidebar — a nav that
            restructures itself mid-navigation is more disorienting than a
            couple of note-shaped sections on a directory page. */}
        {isAppSidebar ? (
          <NavNotesGroups />
        ) : (
          <SettingsNavigation items={settingsNavItems} />
        )}
      </SidebarContent>

      <SidebarFooter className="gap-1 p-0">
        <CtaSidebarButton />
        <NavSecondary supportAction={supportAction} />
        {/* App mode only: in settings the billing screen is one nav item away and shows the same
            figures in full, so a row linking to the page you may already be on is just noise. */}
        {isAppSidebar ? <FirstNoteWalkthroughReplay compact={isMobile} onReplay={() => setOpenMobile(false)} /> : null}
        {isAppSidebar ? <SidebarQuota /> : null}
        <SidebarUpdate />
        {accountSwitcher}
      </SidebarFooter>
    </Sidebar>
    </SidebarNavigation>
  );
}
