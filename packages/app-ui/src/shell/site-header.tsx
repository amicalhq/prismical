'use client';

import { usePathname, useDesktopCapabilities } from '@prismical/app-client';
import { cn } from '../lib/utils';
import { Separator } from '../ui/separator';
import { SidebarTrigger, useSidebar } from '../ui/sidebar';
import { useCurrentNote } from './current-note-context';
import { useTranslation } from 'react-i18next';

// Maps a pathname to the header title, mirroring the desktop
// `getSettingsPageTitle`. Note-detail pages show the note's own title via the
// CurrentNoteContext (registered by the note editor, so the live title is used).
function getStaticPageTitleKey(pathname: string): string | null {
  if (pathname.startsWith('/home')) return 'navigation.pages.home';
  if (pathname.startsWith('/events')) return 'navigation.pages.events';
  if (/^\/notes\/[^/]+/.test(pathname)) return null; // dynamic — resolved from context
  if (pathname.startsWith('/notes')) return 'navigation.pages.notes';
  if (pathname.startsWith('/shared')) return 'navigation.pages.sharedWithMe';
  if (pathname.startsWith('/people')) return 'navigation.pages.people';
  if (pathname.startsWith('/companies')) return 'navigation.pages.companies';
  if (pathname.startsWith('/settings/skills')) return 'navigation.pages.skills';
  const settings: Record<string, string> = {
    '/settings/preferences': 'navigation.pages.preferences',
    '/settings/dictation': 'navigation.pages.transcription',
    '/settings/transcription': 'navigation.pages.transcription',
    '/settings/local-models': 'navigation.pages.localModels',
    '/settings/vocabulary': 'navigation.pages.vocabulary',
    '/settings/calendar': 'navigation.pages.calendar',
    '/settings/billing': 'navigation.pages.billing',
    '/settings/api-keys': 'navigation.pages.apiMcp',
    '/settings/shortcuts': 'navigation.pages.shortcuts',
    '/settings/ai-models': 'navigation.pages.aiModels',
    '/settings/advanced': 'navigation.pages.advanced',
    '/settings/about': 'navigation.pages.about',
  };
  return settings[pathname] ?? 'navigation.pages.settings';
}

export function SiteHeader() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { currentNote } = useCurrentNote();
  const caps = useDesktopCapabilities();
  const { state, isMobile } = useSidebar();
  const staticTitleKey = getStaticPageTitleKey(pathname);
  // For note-detail routes, use the live title from context; fall back to "Note"
  // while the context is not yet populated (e.g. during initial render).
  const title =
    (staticTitleKey ? t(staticTitleKey as never) : null) ??
    currentNote?.title ??
    t('navigation.pages.note');

  // Desktop frameless chrome: the sidebar toggle
  // moves OUT of this header onto the traffic-light row (DesktopChromeStrip,
  // which is also the ONLY drag surface over this header — a drag rect here
  // would repaint over the strip's no-drag toggle when the collapsed header
  // spans the window, since Chromium resolves app-region rects in DOM paint
  // order). Once the sidebar is away (collapsed offcanvas, or the
  // narrow-window sheet) the title shifts right past the lights + pinned
  // toggle (mac) or just the toggle (Windows); Windows also keeps the native
  // overlay corner clear. Web answers false to both and renders as before.
  const macChrome = caps.has('window-chrome-mac');
  const winChrome = caps.has('window-chrome-windows');
  const desktopChrome = macChrome || winChrome;

  // The "New note" action lives in the bottom dock (NewNoteDock), not the header.
  return (
    <header
      className={cn(
        'flex h-[var(--header-height)] w-full shrink-0 gap-2',
        // Desktop frameless chrome: the inset card sits ~8px below the window
        // top, so a 48px-centered title lands ~32px down while the traffic
        // lights/pinned toggle centre at ~24px. Pin the title to a 32px row at
        // the header top (8 + 16 = 24) so all three sit on one line.
        desktopChrome ? 'items-start' : 'items-center',
        winChrome && 'pr-[140px]'
      )}
    >
      <div
        className={cn(
          'flex w-full items-center gap-1 px-4',
          desktopChrome && 'h-8',
          desktopChrome &&
            (state === 'collapsed' || isMobile) &&
            (macChrome ? 'pl-[8.25rem]' : 'pl-[3.25rem]')
        )}
      >
        {!desktopChrome && (
          <>
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 h-4" />
          </>
        )}
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </div>
    </header>
  );
}
