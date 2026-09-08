'use client';

/**
 * The sidebar-footer account/organization switcher — ONE component for web AND
 * desktop, filling the shell's `accountSwitcher` slot on both.
 *
 * It used to be separate web and desktop components. The desktop component
 * supported accounts + sign out only. The desktop half was
 * deliberately session-view-only before desktop's main-owned REST lane shipped.
 * That constraint is gone — every piece this needs is now
 * platform-neutral:
 *   • accounts / activeSub / activeOrgId  → the sanitized SessionView (AuthPort)
 *   • signIn / addAccount / switchAccount / switchOrg / signOut → AuthPort
 *   • the org list, member counts, creation → app-client hooks over TransportPort
 *   • navigation → NavigationPort
 * so the slot stays (the shell shouldn't hard-depend on auth) but both platforms
 * now put the same thing in it.
 *
 * Built on shadcn's canonical `NavUser` pattern: a size="lg" sidebar button with
 * a 32px avatar, name + email and a chevron, opening a dropdown anchored to the
 * trigger width. The dropdown is the organization switcher
 * AND the account switcher: active organization at the top, an account
 * submenu (switch / add), the organization membership list, then appearance and
 * sign-out.
 */

import * as React from 'react';
import { Check, ChevronsUpDown, LogOut, Plus, UserPlus, Users } from 'lucide-react';
import {
  useNavigation,
  usePorts,
  useSessionView,
  useOrganizations,
  useFeatureFlag,
  useViewerProfile,
} from '@prismical/app-client';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '../ui/sidebar';
import { CreateOrganizationDialog } from '../screens/settings/create-organization-dialog';
import { ThemeToggle } from '../screens/settings/theme-toggle';
import { useTranslation } from 'react-i18next';

/**
 * Test hooks. The two e2e suites grew independent id sets against the two old
 * components, so the unified one takes them as a prop rather than forcing a
 * rename in either suite — web keeps its bare ids (the defaults below), desktop
 * passes DESKTOP_ACCOUNT_SWITCHER_TEST_IDS. Collapse to one set whenever both
 * suites can be updated together.
 */
export interface AccountSwitcherTestIds {
  readonly trigger?: string;
  readonly triggerEmail?: string;
  readonly accountSwitcher?: string;
  readonly accountItem?: string;
  readonly addAccount?: string;
  readonly manageMembers?: string;
  readonly addOrganization?: string;
  readonly signOut?: string;
}

const WEB_TEST_IDS: AccountSwitcherTestIds = {
  accountSwitcher: 'account-switcher',
  accountItem: 'account-item',
  addAccount: 'add-account',
  manageMembers: 'manage-members',
  addOrganization: 'add-organization',
};

export const DESKTOP_ACCOUNT_SWITCHER_TEST_IDS: AccountSwitcherTestIds = {
  trigger: 'desktop-account-switcher',
  triggerEmail: 'desktop-account-email',
  // The account rows and Add account moved INTO a submenu when desktop adopted
  // this component (they used to be top-level in its own switcher), so the
  // desktop suite needs a handle on the sub trigger to open it — Radix doesn't
  // mount DropdownMenuSubContent until then.
  accountSwitcher: 'desktop-account-submenu',
  accountItem: 'desktop-switch-account',
  addAccount: 'desktop-add-account',
  signOut: 'desktop-sign-out',
};

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  }
  if (email) {
    const local = email.split('@')[0] ?? email;
    return local.substring(0, 2).toUpperCase();
  }
  return '??';
}

export function AccountSwitcher({ testIds = WEB_TEST_IDS }: { testIds?: AccountSwitcherTestIds }) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const router = useNavigation();
  const { auth } = usePorts();
  const session = useSessionView();
  const { data: orgs } = useOrganizations();
  // The signed-in user's own profile photo; falls back to initials when unset.
  const { data: viewerProfile } = useViewerProfile();
  const [createOpen, setCreateOpen] = React.useState(false);
  // Cloud-only surfaces hide behind org feature flags — never
  // an app-mode branch. Theme stays; the trigger is the workspace identity.
  const { enabled: accountEnabled } = useFeatureFlag('account');
  const { enabled: organizationEnabled } = useFeatureFlag('organization');

  const activeSessionKey = session.activeSessionKey ?? session.activeSub;
  const activeAccount = session.accounts.find(a => (a.sessionKey ?? a.sub) === activeSessionKey);
  const activeOrgId = activeAccount?.activeOrgId ?? null;
  const userName = activeAccount?.name ?? activeAccount?.email ?? t('navigation.account.account');
  const email = activeAccount?.email ?? '';
  const userImage = viewerProfile?.image ?? null;

  const activeOrg = orgs?.find(o => o.orgId === activeOrgId);
  // Trigger shows the active organization as the headline, with the
  // signed-in email beneath it for account identity. Falls back to the user name
  // until the org list loads. (Member count lives in the dropdown header.)
  // `||` not `??` throughout: an org can exist with an EMPTY name, and rendering that
  // as-is gave a blank headline and a "??" avatar - fall through to the user's
  // name/email so initials always resolve to something real.
  const orgName = activeOrg?.name?.trim() || '';
  const triggerName = orgName || userName;
  const triggerSub = email || userName;
  const triggerInitials = getInitials(orgName || userName, email);

  return (
    <SidebarGroup className="pt-0">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  data-testid={testIds.trigger}
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar className="h-8 w-8 rounded-lg">
                    {userImage ? (
                      <AvatarImage src={userImage} alt="" className="rounded-lg" />
                    ) : null}
                    <AvatarFallback className="rounded-lg text-xs">
                      {triggerInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{triggerName}</span>
                    <span
                      className="truncate text-xs text-muted-foreground"
                      data-testid={testIds.triggerEmail}
                    >
                      {triggerSub}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-(--radix-dropdown-menu-trigger-width) min-w-60 rounded-lg"
                side={isMobile ? 'bottom' : 'right'}
                align="end"
                sideOffset={4}
              >
                {/* Active organization */}
                <DropdownMenuLabel className="p-0 font-normal">
                  <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                    <Avatar className="h-8 w-8 rounded-lg">
                      <AvatarFallback className="rounded-lg text-xs">
                        {triggerInitials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">
                        {orgName || t('navigation.account.organization')}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {activeOrg
                          ? t('navigation.account.memberCount', {
                              count: activeOrg.memberCount,
                            })
                          : email}
                      </span>
                    </div>
                  </div>
                </DropdownMenuLabel>

                {/* Account switcher: the signed-in account, with a
                    submenu to switch between accounts or add another. */}
                {accountEnabled && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        className="gap-2"
                        data-testid={testIds.accountSwitcher}
                      >
                        <Avatar className="h-5 w-5 rounded">
                          {userImage ? (
                            <AvatarImage src={userImage} alt="" className="rounded" />
                          ) : null}
                          <AvatarFallback className="rounded text-[10px]">
                            {getInitials(userName, email)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 truncate">{email || userName}</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-56">
                        {session.accounts.map(a => (
                          <DropdownMenuItem
                            key={a.sessionKey ?? a.sub}
                            onClick={() => auth.switchAccount(a.sessionKey ?? a.sub)}
                            className="gap-2"
                            data-testid={testIds.accountItem}
                          >
                            <Avatar className="h-5 w-5 rounded">
                              <AvatarFallback className="rounded text-[10px]">
                                {getInitials(a.name, a.email)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="flex-1 truncate">{a.email || a.name}</span>
                            {(a.sessionKey ?? a.sub) === activeSessionKey && (
                              <Check className="size-4" />
                            )}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => void auth.addAccount()}
                          className="gap-2"
                          data-testid={testIds.addAccount}
                        >
                          <UserPlus className="size-4" />
                          {t('navigation.account.addAccount')}
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </>
                )}

                {/* Organization switcher */}
                {organizationEnabled && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      {t('navigation.account.organizations')}
                    </DropdownMenuLabel>
                    {orgs?.map(o => (
                      <DropdownMenuItem
                        key={o.orgId}
                        onClick={() => auth.switchOrg(o.orgId)}
                        className="gap-2"
                      >
                        <Avatar className="h-5 w-5 rounded">
                          <AvatarFallback className="rounded text-[10px]">
                            {getInitials(o.name?.trim() || userName, email)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 truncate">
                          {o.name?.trim() || t('navigation.account.untitledOrganization')}
                        </span>
                        {o.orgId === activeOrgId && <Check className="size-4" />}
                      </DropdownMenuItem>
                    ))}
                    {activeOrg && (
                      <DropdownMenuItem
                        onClick={() => router.push('/settings/members')}
                        className="gap-2"
                        data-testid={testIds.manageMembers}
                      >
                        <Users className="size-4" />
                        {t('navigation.pages.members')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={() => setCreateOpen(true)}
                      className="gap-2"
                      data-testid={testIds.addOrganization}
                    >
                      <Plus className="size-4" />
                      {t('navigation.account.addOrganization')}
                    </DropdownMenuItem>
                  </>
                )}

                <DropdownMenuSeparator />
                {/* Plain div (not a DropdownMenuItem) so selecting a theme
                 * doesn't close the menu. Same ThemeToggle as Preferences. On
                 * desktop its localStorage write + `.dark` class flip is picked
                 * up by the renderer boot observer (renderer/main/index.ts),
                 * which mirrors it onto nativeTheme.themeSource so native chrome
                 * (traffic lights, Windows caption buttons, vibrancy) follows. */}
                <div className="flex items-center justify-between gap-2 px-1 py-1">
                  <span className="px-1 text-sm">{t('navigation.account.theme')}</span>
                  <ThemeToggle />
                </div>
                {accountEnabled && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => void auth.signOut()}
                      data-testid={testIds.signOut}
                    >
                      <LogOut />
                      {t('navigation.account.signOut')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {organizationEnabled && (
              <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
