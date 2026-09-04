'use client';

import * as React from 'react';
import { AppLink as Link } from '../shell/app-link';
import { CalendarDays, Loader2, Video } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { CalendarReconnectBanner } from './calendar-reconnect-banner';
import { MeetingRowsSkeleton } from './skeletons';
import {
  formatApplicationEventDateLabel,
  formatApplicationEventTimeRange,
  useApplicationLocale,
} from '@prismical/app-i18n';
import { useCalendarEvents, useUpcomingMeetings } from '@prismical/app-client';
import { useAutoSyncConnections, useConnections } from '@prismical/app-client';
import { useOpenNoteForEvent } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// "Connect later" dismissal persists across visits.
const CONNECT_PROMPT_DISMISS_KEY = 'home.connect-calendar-dismissed.v1';

// Shown in place of the meetings section while no calendar is connected.
function ConnectCalendarPrompt({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">{t('calendar.upcoming.title')}</h2>
      <div className="border border-dashed rounded-lg p-6 text-center space-y-4">
        <CalendarDays className="w-8 h-8 text-muted-foreground mx-auto" />
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{t('calendar.upcoming.noConnection')}</p>
          <p className="text-xs text-muted-foreground">
            {t('calendar.upcoming.connectDescription')}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" asChild>
            <Link href="/settings/calendar">{t('calendar.upcoming.connect')}</Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('calendar.upcoming.connectLater')}
          </Button>
        </div>
      </div>
    </section>
  );
}

// The Home "Upcoming meetings" section, fed by the live calendar sync.
// Once any connection exists the section ALWAYS renders (header + "All events ›"),
// varying only its content: reconnect banner for erroring accounts, a centered
// syncing line while a connect settles, a calm one-line all-clear for a quiet
// calendar, or the meeting list. It only disappears entirely while no calendar
// is connected (prompt, or nothing after "Connect later").
export function UpcomingMeetings({ limit = 3 }: { limit?: number }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  // Approach A: opening a meetings surface re-polls the user's connections.
  useAutoSyncConnections();
  const upcomingMeetings = useUpcomingMeetings(limit);
  // Steady 60s poll (same as settings) so a mid-session revocation surfaces as the
  // reconnect banner without a reload — Home is where people actually live.
  const connections = useConnections({ refetchInterval: 60_000 });
  const events = useCalendarEvents();
  const noteForEvent = useOpenNoteForEvent();

  // Safe in a lazy initializer: the connect prompt can't render before the
  // connections query resolves on the client, so SSR/hydration always emit
  // null here regardless of this value.
  const [dismissed, setDismissed] = React.useState<boolean>(
    () => typeof window !== 'undefined' && localStorage.getItem(CONNECT_PROMPT_DISMISS_KEY) === '1'
  );

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(CONNECT_PROMPT_DISMISS_KEY, '1');
    } catch {
      // Storage may be unavailable (private mode) — dismiss for this visit only.
    }
    toast(t('calendar.upcoming.dismissed'));
  };

  // First load: we don't yet know whether a calendar is connected or what's on
  // it. Show a placeholder rather than collapsing — collapsing shifts the notes
  // list below up, then back down when meetings pop in.
  const stillResolving =
    connections.isLoading || ((connections.data?.length ?? 0) > 0 && events.isLoading);
  if (stillResolving && upcomingMeetings.length === 0) {
    return <MeetingRowsSkeleton rows={limit} />;
  }

  // Gate on DATA presence, not query success: a failed background poll flips
  // `isSuccess` while keeping the last-good `data` (and the client never retries),
  // so keying on success would unmount the whole section — banner included — on a
  // single network blip and snap it back a minute later. Stale data beats a jump.
  if (!connections.data) return null; // never loaded — nothing to build on
  if (connections.data.length === 0) {
    return dismissed ? null : <ConnectCalendarPrompt onDismiss={dismiss} />;
  }

  const erroring = connections.data.filter(c => c.status === 'error');
  const active = connections.data.filter(c => c.status === 'active');
  // A connect still settling: staging row (no account yet) or first events pull running.
  const settling = active.some(c => !c.lastSyncedAt);
  // Quiet calendar flavor: rainbow when the calendar HAS events (just none upcoming),
  // sparkles when the synced window is entirely empty.
  const hasAnyEvents = (events.data?.length ?? 0) > 0;
  const firstDayLabel =
    upcomingMeetings.length > 0
      ? formatApplicationEventDateLabel(
          upcomingMeetings[0]!.startAt,
          upcomingMeetings[0]!.isAllDay,
          new Date(),
          resolvedLocale,
          t
        )
      : null;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t('calendar.upcoming.title')}
        </h2>
        <Link
          href="/events"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('calendar.upcoming.allEvents')}
        </Link>
      </div>

      {/* Erroring accounts surface here no matter what else renders — and deliberately
          ignore the "Connect later" dismissal: declining to connect is not the same as
          ignoring a broken existing connection. */}
      {erroring.length > 0 && <CalendarReconnectBanner />}

      {upcomingMeetings.length === 0 ? (
        settling ? (
          <p className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t('calendar.upcoming.syncing')}
          </p>
        ) : active.length > 0 && !events.error ? (
          // Guarded on the events query being healthy: presenting a FAILED events
          // load as "all clear" would be a lie. On error, header (+ banner) alone.
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <span aria-hidden="true">{hasAnyEvents ? '🌈' : '✨'}</span>
            {hasAnyEvents ? t('calendar.upcoming.allClearToday') : t('calendar.upcoming.allClear')}
          </p>
        ) : null /* only erroring connections (banner stands alone) or events failed */
      ) : (
        <>
          {/* No negative margin here: TW4's space-y-4 spaces via the PREVIOUS sibling's
              margin-bottom, so -mb-2 wouldn't tighten the gap - it would replace it and
              pull the card up over this text. */}
          {firstDayLabel && firstDayLabel !== t('common.time.today') && (
            <p className="text-xs text-muted-foreground/70">
              {t('calendar.upcoming.nextUp', { date: firstDayLabel })}
            </p>
          )}
          <div className="overflow-hidden rounded-xl bg-muted py-1">
            {upcomingMeetings.map(meeting => (
              <div
                key={meeting.id}
                className="group flex flex-wrap items-start gap-3 px-4 py-3 transition-colors hover:bg-accent"
              >
                <span
                  className="mt-0.5 h-8 w-1.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: meeting.calendarColor }}
                />

                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    {formatApplicationEventDateLabel(
                      meeting.startAt,
                      meeting.isAllDay,
                      new Date(),
                      resolvedLocale,
                      t
                    )}{' '}
                    <span aria-hidden="true">•</span>{' '}
                    {formatApplicationEventTimeRange(
                      meeting.startAt,
                      meeting.endAt,
                      meeting.isAllDay,
                      resolvedLocale,
                      t
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium leading-tight">{meeting.title}</p>
                    {meeting.meetingUrl && (
                      <Video
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5 self-center sm:hidden group-hover:flex">
                  <Button
                    type="button"
                    size="sm"
                    disabled={noteForEvent.disabled}
                    onClick={() => noteForEvent.open(meeting.id)}
                    className="h-7 cursor-pointer bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/80"
                  >
                    {t('calendar.upcoming.notes')}
                  </Button>
                  {meeting.meetingUrl && (
                    <Button
                      type="button"
                      size="sm"
                      asChild
                      className="h-7 cursor-pointer bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/80"
                    >
                      <a href={meeting.meetingUrl} target="_blank" rel="noopener noreferrer">
                        {t('calendar.upcoming.join')}
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
