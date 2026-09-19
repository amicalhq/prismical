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
  SidebarGroup,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '../ui/sidebar';
import { CommandPaletteTrigger } from './command-palette';
import { NavNotesGroups } from './nav-notes-groups';
import { CtaSidebarButton } from './cta';
import { SidebarUsageNotice, useUsageNoticeTone } from './sidebar-notice';
import { SidebarUpdate } from './sidebar-update';
import {
  SidebarDownloadControl,
  SidebarHelpControl,
  SidebarUsageControl,
} from './sidebar-foot-controls';
import { useHomeNavItems, useSettingsNavItems } from './sidebar-nav';
import { navAnchor } from '../onboarding/anchors';
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
  const { isMobile } = useSidebar();
  // The notice slot holds one card; the CTA stands down when usage claims it.
  const usageNotice = useUsageNoticeTone();
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
          // Brand only. Everything else moved into SidebarContent so it scrolls;
          // this is the sidebar's anchor and is the one thing that stays put.
          // p-0: the header's own padding would stack on the row's, pushing the
          // mark 8px right of the icon column the groups below sit on.
          <SidebarHeader className="p-0">
            <SidebarMenu>
              {/* Brand */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <div
                    data-onboarding="sidebar-brand"
                    className="inline-flex w-full items-center gap-2 font-semibold"
                  >
                    {/* The mark sits in the SAME 16px box every leading icon
                        uses and overflows it evenly, so it centres on the icon
                        column instead of hanging off to the left - and the
                        wordmark starts on the same x as Search and Home.
                        Fixed-size from /public, resolved through the AssetPort
                        so desktop can rebase the prismical-app:// scheme. */}
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <img
                        src={assets.resolve('/prismical-icon.svg')}
                        alt="Prismical"
                        className="size-6 max-w-none"
                      />
                    </span>
                    <span className="font-brand text-base font-medium text-primary">Prismical</span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
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
            <>
              {/* Search and the primary nav scroll WITH the tree. Only the brand
                is pinned above, so a long Favorites/Folders/Tags list gets the
                full height rather than starting ~190px down. */}
              <SidebarGroup className="py-0">
                <SidebarMenu>
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
                        <Link
                          href={item.url}
                          aria-label={item.title}
                          data-onboarding={navAnchor(item.url)}
                        >
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
                        isActive={
                          pathname.startsWith('/people') || pathname.startsWith('/companies')
                        }
                      >
                        <Link
                          href="/people"
                          aria-label={t('navigation.pages.people')}
                          data-onboarding={navAnchor('/people')}
                        >
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
                        <Link
                          href="/shared"
                          aria-label={t('navigation.pages.sharedWithMe')}
                          data-onboarding={navAnchor('/shared')}
                        >
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
                        <Link
                          href={settingsNavItem.url}
                          aria-label={settingsNavItem.title}
                          data-onboarding={navAnchor(settingsNavItem.url)}
                        >
                          <settingsNavItem.icon /> <span>{settingsNavItem.title}</span>
                          {settingsNavItem.shortcut && (
                            <ShortcutHint shortcut={settingsNavItem.shortcut} />
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroup>
              <NavNotesGroups />
            </>
          ) : (
            <SettingsNavigation items={settingsNavItems} />
          )}
        </SidebarContent>

        {/* One row, not a stack. The CTA card, the secondary link icons, the
            walkthrough row, the quota meter and the update row each used to
            claim their own permanent band; between them they spent ~110px of a
            900px window on things a session rarely touches. The quota becomes a
            ring that opens the full figures, the links and the tour fold into
            one help menu, and the CTA takes the single notice slot above the
            row — so the foot can never grow past one card plus one row. */}
        {/* pt-2, not mt-2: the breathing room above the foot has to live INSIDE
            it. As a margin it left an 8px gap that the scroller did not cover,
            so the bottom fade resolved in mid-air short of the footer while the
            top one resolved exactly at the brand - which is why only the bottom
            read as odd. */}
        <SidebarFooter className="relative gap-0 p-0 pt-2">
          {/* ONE slot, by priority. A usage problem outranks a campaign - a
              promo must never sit on top of "transcription is paused" - so the
              CTA stands down while the notice is up, and the foot cannot grow
              past one card plus one row however many things want to speak. */}
          {isAppSidebar ? <SidebarUsageNotice /> : null}
          {isAppSidebar && !usageNotice ? <CtaSidebarButton /> : null}
          {/* Self-hides unless the desktop app has an update staged, so it costs
              nothing in the ordinary case. */}
          <SidebarUpdate />
          <div className="flex w-full items-center gap-1 px-1 py-1.5">
            {accountSwitcher}
            {isAppSidebar ? <SidebarUsageControl /> : null}
            <SidebarDownloadControl />
            <SidebarHelpControl supportAction={supportAction} />
          </div>
        </SidebarFooter>
      </Sidebar>
    </SidebarNavigation>
  );
}
