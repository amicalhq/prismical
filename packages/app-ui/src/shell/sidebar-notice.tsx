'use client';

// The notice slot: ONE card directly above the account row, inside the pinned
// foot so it never scrolls away.
//
// Design intent. These have to belong to the panel and still be noticed, and
// those pull against each other. A card washed in its severity colour wins the
// second and loses the first - it reads as a foreign object dropped into the
// sidebar. So the card itself always wears the panel's own surface, and the
// severity lives in the ICON and the ACTION only. That is enough to tell an
// alert from an offer at a glance, without a block of red sitting under a quiet
// grey tree.
//
// Urgency escalates in one step rather than continuously: a warning tints its
// icon, an exhausted state also tints its border. Nothing gets a filled
// background, because the next thing below it is the account row and the two
// would compete.

import { AlertTriangle, CircleAlert } from 'lucide-react';
import { useCloudTranscriptionQuota, type UsageCopy } from '@prismical/app-client';
import { formatApplicationDurationCompact, useApplicationLocale } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';
import { AppLink as Link } from './app-link';
import { cn } from '../lib/utils';

/** Below this share of the allowance remaining, the meter warns. */
const LOW_REMAINING_RATIO = 0.1;

type Tone = 'warning' | 'danger';

function useCopy(copy: UsageCopy | null | undefined, catalogKey: string): string | null {
  const { t, i18n } = useTranslation();
  if (!copy) return null;
  if (copy.text) return copy.text;
  return i18n.exists(catalogKey) ? t(catalogKey as never) : null;
}

export function SidebarNoticeCard({
  tone,
  title,
  actionLabel,
  actionHref,
  actionExternal,
}: {
  tone: Tone;
  title: string;
  actionLabel?: string | null;
  actionHref?: string | null;
  actionExternal?: boolean;
}) {
  const Icon = tone === 'danger' ? CircleAlert : AlertTriangle;
  const action =
    actionLabel && actionHref ? (
      actionExternal ? (
        <a
          href={actionHref}
          target="_blank"
          rel="noreferrer"
          className={cn('mt-1.5 inline-block text-[11px] font-medium hover:underline', TEXT[tone])}
        >
          {actionLabel}
        </a>
      ) : (
        <Link
          href={actionHref}
          className={cn('mt-1.5 inline-block text-[11px] font-medium hover:underline', TEXT[tone])}
        >
          {actionLabel}
        </Link>
      )
    ) : null;

  return (
    <div
      className={cn(
        'mx-2 mb-1 rounded-lg border bg-sidebar-accent/60 px-2.5 py-2',
        tone === 'danger' ? 'border-destructive/30' : 'border-sidebar-border'
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={cn('size-3.5 shrink-0', TEXT[tone])} aria-hidden="true" />
        <span className="truncate text-[11px] font-medium text-sidebar-foreground">{title}</span>
      </div>
      {action}
    </div>
  );
}

const TEXT: Record<Tone, string> = {
  warning: 'text-warning',
  danger: 'text-destructive',
};

/**
 * The usage notice. The ring in the row below is the ambient signal — it is
 * always there and answers "am I fine?". This appears only when the answer is
 * no, so the sidebar stays quiet in the case that covers most of the month.
 *
 * Everything it says about plans comes from the server's own `action`; nothing
 * here branches on a plan, a tier or a vendor.
 */
/**
 * Whether the usage notice will draw, and how loudly. The foot shows ONE card,
 * so whoever else wants the slot has to be able to ask first - a campaign must
 * not sit on top of "transcription is paused".
 */
export function useUsageNoticeTone(): Tone | null {
  const quota = useCloudTranscriptionQuota();
  if (!quota) return null;
  const remaining = Math.max(0, quota.limitSeconds - quota.usedSeconds);
  if (remaining === 0) return 'danger';
  return remaining / quota.limitSeconds < LOW_REMAINING_RATIO ? 'warning' : null;
}

export function SidebarUsageNotice() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const quota = useCloudTranscriptionQuota();
  const tone = useUsageNoticeTone();
  const actionLabel = useCopy(
    quota?.action,
    `navigation.quota.action.${quota?.action?.kind ?? ''}`
  );

  if (!quota || !tone) return null;

  const remaining = Math.max(0, quota.limitSeconds - quota.usedSeconds);
  const exhausted = tone === 'danger';

  const left = formatApplicationDurationCompact(remaining * 1000, resolvedLocale, t);

  return (
    <SidebarNoticeCard
      tone={tone}
      // One line, no prose: the state and the number, then the way out.
      title={
        exhausted
          ? t('navigation.quota.limitReached')
          : t('navigation.quota.approachingLimit', { duration: left })
      }
      actionLabel={actionLabel}
      actionHref={quota.action?.href ?? null}
      actionExternal={quota.action?.external}
    />
  );
}
