/**
 * The local-mode sidebar footer is desktop-owned.
 *
 * In cloud mode the shell's `accountSwitcher` slot holds the shared
 * AccountSwitcher (accounts, organizations, members, sign-out). The local
 * workspace has none of those — its synthetic identity (LOCAL_WORKSPACE) is a
 * sync-partition key, not something to show — so the desktop router fills the
 * same slot with this: the workspace name, the theme row the switcher also
 * carries, and the way to the mode switch. No shared code learns the mode.
 */
import { Repeat } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@prismical/app-client';
import { Avatar, AvatarFallback } from '@prismical/app-ui/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@prismical/app-ui/ui/dropdown-menu';
import { ThemeToggle } from '@prismical/app-ui/screens/settings/theme-toggle';

const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? '';
  return `${first}${second}`.toUpperCase() || name.slice(0, 2).toUpperCase();
};

export function LocalWorkspaceFooter() {
  const { t } = useTranslation();
  const router = useNavigation();
  const name = t('desktop.localWorkspace.name');
  const subtitle = t('desktop.localWorkspace.subtitle');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="desktop-workspace-footer"
          title={name}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
        >
          <Avatar className="size-6 shrink-0 rounded-md">
            <AvatarFallback className="rounded-md text-[10px]">{initialsOf(name)}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate font-medium">{name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-(--radix-dropdown-menu-trigger-width) min-w-60 rounded-lg"
        side="right"
        align="end"
        sideOffset={4}
      >
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <Avatar className="h-8 w-8 rounded-lg">
              <AvatarFallback className="rounded-lg text-xs">{initialsOf(name)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Plain div (not a DropdownMenuItem) so selecting a theme does
                    not close the menu — the same row the AccountSwitcher has. */}
        <div className="flex items-center justify-between gap-2 px-1 py-1">
          <span className="px-1 text-sm">{t('navigation.account.theme')}</span>
          <ThemeToggle />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => router.push('/settings/advanced')}
          data-testid="desktop-workspace-switch-mode"
        >
          <Repeat />
          {t('desktop.localWorkspace.switchMode')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
