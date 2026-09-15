'use client';

// The two controls that sit beside the account in the sidebar foot.
//
// Both replace a block that used to claim its own permanent band down there:
// SidebarQuota became the ring + its popover, and NavSecondary's row of link
// icons became one help menu. The foot is now a single row, so the tree keeps
// the height those blocks were spending.
//
// Everything the usage control renders is decided by core and arrives on the
// quota payload — the label, whether there is a call to action, what it says and
// where it points. Nothing here may branch on a plan, a tier or a vendor: this
// file is public source and ships to the open-source desktop app.

import * as React from 'react';
import { BookText, CircleHelp, Download, MessageSquare, PlayCircle } from 'lucide-react';
import { IconBrandDiscord } from '@tabler/icons-react';
import {
  useCloudTranscriptionQuota,
  useDesktopCapabilities,
  type UsageCopy,
} from '@prismical/app-client';
import {
  formatApplicationDuration,
  formatApplicationDurationCompact,
  useApplicationLocale,
} from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';
import { AppLink as Link } from './app-link';
import { useWalkthroughReplay } from '../onboarding/first-note-walkthrough';
import { cn } from '../lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

/** Below this share of the allowance remaining, the meter warns. */
const LOW_REMAINING_RATIO = 0.1;

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Server copy wins when sent, so wording can change without a client release. */
function useCopy(copy: UsageCopy | null | undefined, catalogKey: string): string | null {
  const { t, i18n } = useTranslation();
  if (!copy) return null;
  if (copy.text) return copy.text;
  return i18n.exists(catalogKey) ? t(catalogKey as never) : null;
}

/**
 * `ratio` is what is LEFT, not what is spent - the arc empties as the allowance
 * goes, like a fuel gauge. Drawing consumption instead made the warning state a
 * nearly complete ring, which reads as "full" at the exact moment it means the
 * opposite.
 */
function UsageRing({ ratio, tone }: { ratio: number; tone: string }) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="text-sidebar-foreground/20"
      />
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - clamped)}
        transform="rotate(-90 8 8)"
        className={tone}
      />
    </svg>
  );
}

/**
 * The Cloud-transcription meter, as a ring that opens the full figures. The ring
 * alone answers "am I fine?"; the popover answers "how much, and what do I do
 * about it?" without a trip to the billing screen.
 */
export function SidebarUsageControl() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const quota = useCloudTranscriptionQuota();

  const label = useCopy(quota?.label, `navigation.quota.label.${quota?.label.kind ?? ''}`);
  const actionLabel = useCopy(
    quota?.action,
    `navigation.quota.action.${quota?.action?.kind ?? ''}`
  );

  // An unlimited plan, an older core, or a response in flight: nothing to draw.
  if (!quota) return null;

  const limit = quota.limitSeconds;
  const remaining = Math.max(0, limit - quota.usedSeconds);
  const exhausted = remaining === 0;
  const low = !exhausted && remaining / limit < LOW_REMAINING_RATIO;
  const tone = exhausted ? 'text-destructive' : low ? 'text-warning' : 'text-sidebar-foreground/60';

  const duration = (seconds: number) =>
    formatApplicationDuration(seconds * 1000, resolvedLocale, t);
  const compactDuration = (seconds: number) =>
    formatApplicationDurationCompact(seconds * 1000, resolvedLocale, t);

  // The figure SHOWN is narrow ("3h left") because it shares a line with the
  // label. Anything READ rather than glanced at - the trigger's accessible name
  // - keeps the full form ("3 hrs left"), which a screen reader pronounces
  // correctly.
  const remainingText = exhausted
    ? t('navigation.quota.noTimeLeft')
    : t('navigation.quota.left', { duration: compactDuration(remaining) });
  const remainingLabel = exhausted
    ? t('navigation.quota.noTimeLeft')
    : t('navigation.quota.left', { duration: duration(remaining) });
  const detail = t('navigation.quota.detail', {
    used: duration(quota.usedSeconds),
    limit: duration(limit),
    date: new Intl.DateTimeFormat(resolvedLocale, {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
    }).format(new Date(quota.resetsAt)),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label ?? ''} ${remainingLabel}`.trim()}
          className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent"
        >
          <UsageRing ratio={limit === 0 ? 0 : remaining / limit} tone={tone} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64 rounded-lg p-3">
        {/* The remaining time rides the title line rather than taking one of
            its own - it is the headline number, not a footnote. */}
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-xs font-medium">{label}</p>
          <p
            className={cn(
              'shrink-0 text-[11px] font-medium tabular-nums',
              low && 'text-warning',
              exhausted && 'text-destructive'
            )}
          >
            {remainingText}
          </p>
        </div>
        {/* Like the ring, the bar shows what is LEFT and empties as it goes. A
            filling bar next to "15m left" says the opposite of the label. */}
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-sidebar-foreground/20"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((limit === 0 ? 0 : remaining / limit) * 100)}
          aria-label={detail}
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width]',
              exhausted ? 'bg-destructive' : low ? 'bg-warning' : 'bg-primary'
            )}
            style={{ width: `${(limit === 0 ? 0 : remaining / limit) * 100}%` }}
          />
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
        {quota.action && actionLabel ? (
          quota.action.external ? (
            <a
              href={quota.action.href}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block rounded-md bg-primary px-2 py-1.5 text-center text-[11px] font-medium text-primary-foreground hover:opacity-90"
            >
              {actionLabel}
            </a>
          ) : (
            <Link
              href={quota.action.href}
              className="mt-3 block rounded-md bg-primary px-2 py-1.5 text-center text-[11px] font-medium text-primary-foreground hover:opacity-90"
            >
              {actionLabel}
            </Link>
          )
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Getting the desktop and mobile apps, as its own control rather than only a
 * menu entry — it is the one thing down here we actively want a web user to
 * find. Web only: on desktop you are already in the app.
 */
export function SidebarDownloadControl() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  if (caps.has('global-shortcuts')) return null;
  return (
    <a
      href="https://prismical.ai/apps"
      target="_blank"
      rel="noreferrer"
      aria-label={t('navigation.secondary.downloadApps')}
      title={t('navigation.secondary.downloadApps')}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
    >
      <Download className="size-4" />
    </a>
  );
}

/**
 * Docs, community, support, the product tour and any staged app update, behind
 * one icon. These are destinations almost nobody opens in a session, so they
 * cost one button rather than a permanent row each.
 */
export function SidebarHelpControl({
  supportAction,
  updateHref,
}: {
  /** Platform-supplied live-chat launcher (web: Gleap). */
  supportAction?: React.ReactNode;
  /** Shown only when the desktop app has an update staged. */
  updateHref?: string;
}) {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  // Null while the walkthrough has nothing to replay, which is also when the
  // footer's standalone replay row used to hide itself.
  const replay = useWalkthroughReplay();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('navigation.secondary.help')}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <CircleHelp className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-52 rounded-lg">
        <DropdownMenuItem asChild>
          <a href="https://prismical.ai/docs" target="_blank" rel="noreferrer">
            <BookText className="size-4" />
            <span>{t('navigation.secondary.docs')}</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="https://prismical.ai/community" target="_blank" rel="noreferrer">
            <IconBrandDiscord className="size-4" />
            <span>Discord</span>
          </a>
        </DropdownMenuItem>
        {/* The platform supplies the whole row, icon and label - it owns both
            the wording and what a click does (web: open the Gleap widget). Do
            not add an icon around it: this wrapped it in one, and the launcher
            arrived carrying its own, so the row read as two icons and no text. */}
        {/* w-full because the platform may hand us a <button>, and a form
            control resolves width:auto to fit-content rather than filling its
            line the way the anchor rows do - which left this row clickable only
            across its text. */}
        {supportAction ? (
          <DropdownMenuItem asChild className="w-full">
            {supportAction}
          </DropdownMenuItem>
        ) : (
          // The old icon row fell back to mail when no live-chat launcher was
          // supplied. Keep that: a platform without Gleap still needs a way to
          // reach someone.
          <DropdownMenuItem asChild>
            <a href="mailto:help@prismical.ai">
              <MessageSquare className="size-4" />
              <span>{t('navigation.secondary.feedback')}</span>
            </a>
          </DropdownMenuItem>
        )}
        {/* Web only, as before: on desktop you are already in the app. */}
        {!caps.has('global-shortcuts') ? (
          <DropdownMenuItem asChild>
            <a href="https://prismical.ai/apps" target="_blank" rel="noreferrer">
              <Download className="size-4" />
              <span>{t('navigation.secondary.downloadApps')}</span>
            </a>
          </DropdownMenuItem>
        ) : null}
        {replay ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={replay}>
              <PlayCircle className="size-4" />
              <span>{t('onboarding.replayTitle')}</span>
            </DropdownMenuItem>
          </>
        ) : null}
        {updateHref ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={updateHref}>
                <Download className="size-4" />
                <span>{t('settings.about.updates.sidebarCta')}</span>
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
