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
 * user identity. The dropdown groups personal settings and account switching,
 * then organization switching and management, appearance, and sign-out.
 */

import * as React from 'react';
import {
  ArrowLeftRight,
  Check,
  ChevronsUpDown,
  CreditCard,
  LogOut,
  Plus,
  UserRound,
  UserPlus,
  Users,
} from 'lucide-react';
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
import { SidebarPlanBadge, SidebarPlanPill } from './sidebar-plan-pill';
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
  // Web had no handle on the trigger while it showed the email, because the
  // suites could just find it by that text. The compact foot names the person
  // instead, so there has to be one.
  trigger: 'account-trigger',
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

/**
 * A leading token that is an abbreviation rather than a name: "Dr.", "A.",
 * "J." - anything punctuated, or a lone letter. Two unpunctuated capitals are
 * NOT this: "OJ Kwon" is how that person is named, not an abbreviation of it.
 */
const ABBREVIATION = /^(?:\p{L}\.?|\p{L}[\p{L}.]*\.)$/u;

/** Below this a first name is too terse to stand alone, so it keeps the next word. */
const TERSE_NAME_CHARS = 2;

/**
 * What the plan chip's separator returns to the name when it hides itself: the
 * dot (3.56px at this size) plus its 3px margin, rounded up. Over-stating it
 * only means staying clamped a shade longer; under-stating it lets the loop in
 * useClamped close.
 */
const SEPARATOR_WIDTH_PX = 8;

/**
 * The shortest form of a person's name that still identifies them, for the
 * sidebar foot - a row that shares ~100px with the plan chip, so the full name
 * would truncate to something unrecognisable.
 *
 * Usually the given name, but two cases are not:
 *   - "Dr. Sarah Chen" / "J. R. R. Tolkien": the leading tokens abbreviate, so
 *     they are skipped and the first real word wins ("Sarah", "Tolkien").
 *   - "OJ Kwon", "Li Wei": a first name of a letter or two carries too little
 *     alone, so the next word comes with it.
 *
 * With no name it falls back to the WHOLE email address. Nothing is cut from
 * it on purpose: an address has no word that stands for the person the way a
 * name does, so any piece we chose would be a different address rather than a
 * short form of theirs. The domain in particular has to stay - a team that
 * signs up as prismical@their-company.com shares the local part, and the
 * domain is the only half that tells them apart.
 *
 * Nothing here is a hard character cap: the row's width varies by plan, so the
 * final trim is CSS truncation against the space actually available.
 */
export function shortPersonName(name?: string | null, email?: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  // Everything abbreviates ("J. R. R.") - the last token is the only real name.
  const named = words.filter(word => !ABBREVIATION.test(word));
  const usable = named.length > 0 ? named : words.slice(-1);
  const [first, second] = usable;
  if (first) {
    return first.length <= TERSE_NAME_CHARS && second ? `${first} ${second}` : first;
  }

  return email ?? '';
}

/**
 * Whether a truncating element is actually cutting its text right now.
 *
 * Worth knowing because CSS truncation fits WHOLE characters: the text stops
 * up to a character short of the box, and that remainder is inside the element,
 * where no margin can reach it. Stacked on the row's gap it read as a hole
 * after the ellipsis. What sees it is the neighbour, which can pull itself
 * closer for exactly as long as the clamp lasts.
 *
 * Re-measured on resize, since the row's width changes with the plan (an
 * unlimited plan draws no usage meter) and with the panel itself.
 *
 * `reclaimedPx` is what the neighbour GIVES BACK when it reacts, and it is the
 * difference between this working and this spinning. The separator it hides is
 * `display:none`, so those pixels return to this very element - the one being
 * measured. Without the gap between the two thresholds, a name that lands
 * inside that window clamps, gains the pixels, unclamps, loses them, and
 * clamps again, once per frame, forever. Measured at exactly twelve characters
 * on a Tier 1 account: 32 flips in 260ms.
 */
function useClamped(
  text: string,
  reclaimedPx = 0
): [React.RefObject<HTMLSpanElement | null>, boolean] {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [clamped, setClamped] = React.useState(false);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setClamped(was =>
        // Unclamping has to survive the neighbour coming back, so it is judged
        // against the narrower box that would follow, not the current one.
        was
          ? element.scrollWidth > element.clientWidth - reclaimedPx
          : element.scrollWidth > element.clientWidth
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, reclaimedPx]);
  return [ref, clamped];
}

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

export function AccountSwitcher({
  testIds = WEB_TEST_IDS,
  compact = false,
}: {
  testIds?: AccountSwitcherTestIds;
  /**
   * Render the TRIGGER as a single short row that sits inline beside the usage
   * and help controls, instead of the two-line block in its own group. The menu
   * itself is identical either way — only the trigger changes, so there is no
   * second copy of the account/org/theme/sign-out logic to drift.
   */
  compact?: boolean;
}) {
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
  // an app-mode branch. Theme stays; the trigger is the user identity.
  const { enabled: accountEnabled } = useFeatureFlag('account');
  const { enabled: organizationEnabled } = useFeatureFlag('organization');
  const { enabled: billingEnabled } = useFeatureFlag('billing');

  const activeSessionKey = session.activeSessionKey ?? session.activeSub;
  const activeAccount = session.accounts.find(a => (a.sessionKey ?? a.sub) === activeSessionKey);
  const activeOrgId = activeAccount?.activeOrgId ?? null;
  const userName =
    viewerProfile?.name?.trim() ||
    activeAccount?.name ||
    activeAccount?.email ||
    t('navigation.account.account');
  const email = activeAccount?.email ?? '';
  const userImage = viewerProfile?.image ?? null;

  const activeOrg = orgs?.find(o => o.orgId === activeOrgId);
  const orgName = activeOrg?.name?.trim() || '';
  const triggerName = userName;
  const triggerSub = email || userName;
  const triggerInitials = getInitials(userName, email);
  const canManageBilling = activeOrg?.role === 'owner' || activeOrg?.role === 'admin';

  // The compact row names the PERSON, not the workspace: it sits beside that
  // person's usage and their own account menu, and the org is already the
  // headline inside that menu.
  const compactName = shortPersonName(viewerProfile?.name ?? activeAccount?.name, email) || userName;
  const compactInitials = getInitials(viewerProfile?.name ?? activeAccount?.name ?? null, email);
  const [nameRef, nameClamped] = useClamped(compactName, SEPARATOR_WIDTH_PX);

  // The trigger is the only thing the two modes disagree about. Compact drops
  // the second line and the chevron: the row is short, the avatar already reads
  // as an account control, and the space goes to the usage and help controls
  // beside it.
  const trigger = compact ? (
    <button
      type="button"
      data-testid={testIds.trigger}
      // The plan beside it reads this to close the gap once the name clamps.
      data-name-clamped={nameClamped || undefined}
      className="group/account-name flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
    >
      <Avatar className="size-[22px] shrink-0 rounded-full">
        {userImage ? <AvatarImage src={userImage} alt="" className="rounded-full" /> : null}
        <AvatarFallback className="rounded-full text-[10px]">{compactInitials}</AvatarFallback>
      </Avatar>
      {/* No title: the row is a menu trigger, and the menu it opens carries the
          full name already. */}
      <span ref={nameRef} className="truncate text-xs text-sidebar-foreground">
        {compactName}
      </span>
      <SidebarPlanPill />
      {/* Inside the trigger, so clicking it opens the menu like the rest of the
          row - and aria-hidden, so it does not turn the trigger's name into
          "Naomi Upgrade". The Billing row inside that menu carries the same
          badge with a real label, which is where a screen reader meets it.
          A SPAN is fine here; what broke before was an <a>, an interactive
          element nested in a button. */}
      <span aria-hidden="true">
        <SidebarPlanBadge />
      </span>
    </button>
  ) : (
    <SidebarMenuButton
      size="lg"
      data-testid={testIds.trigger}
      className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
    >
      <Avatar className="h-8 w-8 rounded-lg">
        {userImage ? <AvatarImage src={userImage} alt="" className="rounded-lg" /> : null}
        <AvatarFallback className="rounded-lg text-xs">{triggerInitials}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{triggerName}</span>
        <span className="truncate text-xs text-muted-foreground" data-testid={testIds.triggerEmail}>
          {triggerSub}
        </span>
      </div>
      <ChevronsUpDown className="ml-auto size-4" />
    </SidebarMenuButton>
  );

  const menu = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-72 max-w-[calc(100vw-2rem)] rounded-lg"
          side={isMobile ? 'bottom' : 'right'}
          align="end"
          sideOffset={4}
        >
          {/* Signed-in user */}
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage src={userImage ?? undefined} alt="" className="rounded-lg" />
                <AvatarFallback className="rounded-lg text-xs">{triggerInitials}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{userName}</span>
                <span className="truncate text-xs text-muted-foreground">{email}</span>
              </div>
            </div>
          </DropdownMenuLabel>

          {/* Account switcher: the signed-in account, with a
                    submenu to switch between accounts or add another. */}
          {accountEnabled && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push('/settings/account')} className="gap-2">
                <UserRound className="size-4" />
                {t('navigation.account.accountSettings')}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2" data-testid={testIds.accountSwitcher}>
                  <ArrowLeftRight className="size-4" />
                  <span className="flex-1 truncate">{t('navigation.account.switchAccount')}</span>
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
                      {(a.sessionKey ?? a.sub) === activeSessionKey && <Check className="size-4" />}
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
                {t('navigation.account.organization')}
              </DropdownMenuLabel>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2">
                  <Avatar className="h-5 w-5 rounded">
                    <AvatarFallback className="rounded text-[10px]">
                      {getInitials(orgName || userName, email)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate">
                    {orgName || t('navigation.account.organization')}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-56">
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
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setCreateOpen(true)}
                    className="gap-2"
                    data-testid={testIds.addOrganization}
                  >
                    <Plus className="size-4" />
                    {t('navigation.account.addOrganization')}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
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

              {billingEnabled && canManageBilling && (
                <DropdownMenuItem
                  onClick={() => router.push('/settings/billing')}
                  className="gap-2"
                >
                  <CreditCard className="size-4" />
                  {t('navigation.pages.billing')}
                  {/* The offer rides this row rather than being its own target:
                      the row already goes where upgrading happens, and a link
                      inside a menu item would be a second click target inside a
                      control that is already one. */}
                  <SidebarPlanBadge />
                </DropdownMenuItem>
              )}
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
    </>
  );

  // Compact returns the menu bare: the sidebar foot owns the row that places it
  // beside the usage and help controls, so this component stays responsible for
  // the account only.
  if (compact) return menu;

  return (
    <SidebarGroup className="pt-0">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>{menu}</SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
