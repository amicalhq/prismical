'use client';

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudTranscriptionQuota, type UsageCopy } from '@prismical/app-client';
import {
  formatApplicationDuration,
  formatApplicationDurationCompact,
  useApplicationLocale,
} from '@prismical/app-i18n';
import { AppLink as Link } from './app-link';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

// The Cloud-transcription meter at the foot of the sidebar.
//
// EVERY decision it renders — the label, whether there is an upgrade, what it says and where it
// points — is resolved by core and arrives on the response. Nothing here may branch on a plan, a
// tier or a vendor: this file is public source and ships to the open-source desktop app. If a case
// needs different behavior, it changes in core, not here.

/** Below this share of the allowance remaining, the meter warns. */
const LOW_REMAINING_RATIO = 0.1;

/**
 * Server copy wins when it is sent, so wording can be changed (or a variant shipped) without a
 * client release; otherwise the `kind` resolves against this app's catalog. An unknown kind from a
 * newer core renders nothing rather than a raw identifier.
 */
function useCopy(copy: UsageCopy | null | undefined, catalogKey: string): string | null {
  const { t, i18n } = useTranslation();
  if (!copy) return null;
  if (copy.text) return copy.text;
  return i18n.exists(catalogKey) ? t(catalogKey as never) : null;
}

export function SidebarQuota() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const quota = useCloudTranscriptionQuota();

  // Kinds are catalog keys by construction, so a new one shipped from core needs only a catalog
  // entry here — never a code change.
  const label = useCopy(quota?.label, `navigation.quota.label.${quota?.label.kind ?? ''}`);
  const actionLabel = useCopy(
    quota?.action,
    `navigation.quota.action.${quota?.action?.kind ?? ''}`
  );

  // An unlimited plan, an older core, or a response in flight: nothing to draw. The hook has
  // already dropped the unlimited case, so `limitSeconds` is a number from here down.
  if (!quota) return null;

  const limit = quota.limitSeconds;
  // Used can overshoot the limit — a re-metered chunk, or another member spending a pooled
  // allowance between the gate and this read — so both the bar and the remaining time clamp.
  const remaining = Math.max(0, limit - quota.usedSeconds);
  const usedRatio = limit === 0 ? 1 : Math.min(1, quota.usedSeconds / limit);
  const exhausted = remaining === 0;
  const low = !exhausted && remaining / limit < LOW_REMAINING_RATIO;

  const duration = (seconds: number) =>
    formatApplicationDuration(seconds * 1000, resolvedLocale, t);
  // The meter shares one line with its label, so the figure ON it is narrow ("4h 58m"). Everything
  // that is READ rather than glanced at - the tooltip detail, the link's accessible name - keeps
  // the full form ("4 hrs 58 min"), which a screen reader pronounces correctly.
  const compactDuration = (seconds: number) =>
    formatApplicationDurationCompact(seconds * 1000, resolvedLocale, t);

  const remainingText = exhausted
    ? t('navigation.quota.noTimeLeft')
    : t('navigation.quota.left', { duration: compactDuration(remaining) });
  const remainingLabel = exhausted
    ? t('navigation.quota.noTimeLeft')
    : t('navigation.quota.left', { duration: duration(remaining) });

  const detail = t('navigation.quota.detail', {
    used: duration(quota.usedSeconds),
    limit: duration(limit),
    // The period boundary is a UTC instant on a half-open bucket, so a period ending
    // 2026-10-01T00:00Z resets ON 1 October; formatted in local time west of UTC that same
    // instant renders as 30 September, a day the meter never resets.
    date: new Intl.DateTimeFormat(resolvedLocale, {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
    }).format(new Date(quota.resetsAt)),
  });

  const action = quota.action;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'relative mx-2 rounded-md px-2 py-2 transition-colors',
            quota.href && 'hover:bg-sidebar-accent'
          )}
        >
          {/* Stretched link: the whole block is the target, but the call to action below is its
              own link with its own href, and anchors cannot nest. */}
          {quota.href ? (
            <Link
              href={quota.href}
              aria-label={`${label ?? ''} ${remainingLabel}`.trim()}
              className="absolute inset-0 rounded-md"
            />
          ) : null}

          <div className="pointer-events-none relative">
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate text-sidebar-foreground-muted">{label}</span>
              <span
                className={cn(
                  'shrink-0 tabular-nums',
                  exhausted
                    ? 'text-destructive'
                    : low
                      ? 'text-warning'
                      : 'text-sidebar-foreground-muted'
                )}
              >
                {remainingText}
              </span>
            </div>

            <div
              className="mt-1.5 h-1 overflow-hidden rounded-full bg-sidebar-foreground/20"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedRatio * 100)}
              aria-label={detail}
            >
              <div
                className={cn(
                  'h-full rounded-full transition-[width]',
                  exhausted ? 'bg-destructive' : low ? 'bg-warning' : 'bg-primary'
                )}
                style={{ width: `${usedRatio * 100}%` }}
              />
            </div>

            {/* The call to action never takes the warning colours: it is an offer, not an alert. */}
            {action && actionLabel ? (
              action.external ? (
                <a
                  href={action.href}
                  target="_blank"
                  rel="noreferrer"
                  className="pointer-events-auto relative mt-2 inline-block text-[11px] text-sidebar-foreground hover:underline"
                >
                  {actionLabel}
                </a>
              ) : (
                <Link
                  href={action.href}
                  className="pointer-events-auto relative mt-2 inline-block text-[11px] text-sidebar-foreground hover:underline"
                >
                  {actionLabel}
                </Link>
              )
            ) : null}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">{detail}</TooltipContent>
    </Tooltip>
  );
}
