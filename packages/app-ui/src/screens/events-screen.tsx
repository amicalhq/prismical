'use client';

import { AppLink as Link } from '../shell/app-link';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import {
  useCalendarEvents,
  useAutoSyncConnections,
  useConnections,
  useOpenNoteForEvent,
} from '@prismical/app-client';
import type { CalendarEvent } from '@prismical/app-contracts';
import { allDayStillCurrent, eventDayKey } from '../lib/utils';
import { AlertCircle, CalendarDays, Users, Video } from 'lucide-react';
import { CalendarReconnectBanner } from '../components/calendar-reconnect-banner';
import {
  formatApplicationEventDateLabel,
  formatApplicationEventTimeRange,
  useApplicationLocale,
} from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';

// Events screen.

// ─── Date helpers ─────────────────────────────────────────────────────────────
// All-day awareness (UTC vs local day reads) lives in the shared helpers —
// see eventDayKey/getEventDateLabel in lib/utils.

// ─── Grouping ─────────────────────────────────────────────────────────────────

interface DateGroup {
  dateKey: number;
  label: string;
  meetings: CalendarEvent[];
}

function groupByDate(
  calendarEvents: CalendarEvent[],
  labelForEvent: (event: CalendarEvent) => string
): DateGroup[] {
  const groups = new Map<number, DateGroup>();

  for (const event of calendarEvents) {
    const key = eventDayKey(new Date(event.start), event.isAllDay);
    if (!groups.has(key)) {
      groups.set(key, {
        dateKey: key,
        label: labelForEvent(event),
        meetings: [],
      });
    }
    groups.get(key)!.meetings.push(event);
  }

  return Array.from(groups.values()).sort((a, b) => a.dateKey - b.dateKey);
}

// ─── Meeting icon helper ──────────────────────────────────────────────────────

function MeetingIcon({ joinUrl }: { joinUrl?: string }) {
  if (!joinUrl) return null;
  return <Video className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function EventsScreen() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  // Approach A: opening the events view re-polls the user's connections.
  useAutoSyncConnections();
  const { data: allEvents, isLoading, error } = useCalendarEvents();
  const noteForEvent = useOpenNoteForEvent();
  const connections = useConnections();
  const hasConnection = (connections.data?.length ?? 0) > 0;
  const allErroring = hasConnection && (connections.data ?? []).every(c => c.status === 'error');

  // The sync window also keeps ~7 days of history — show today onward here
  // (an in-progress meeting still counts via its end time; all-day events use
  // UTC-keyed day comparison, see lib/utils).
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const upcoming = (allEvents ?? []).filter(e =>
    e.isAllDay
      ? allDayStillCurrent(new Date(e.start), new Date(e.end), now)
      : new Date(e.end).getTime() >= todayStart.getTime()
  );
  const dateGroups = groupByDate(upcoming, event =>
    formatApplicationEventDateLabel(
      new Date(event.start),
      event.isAllDay ?? false,
      new Date(),
      resolvedLocale,
      t,
      { weekday: 'long', month: 'short', day: 'numeric' }
    )
  );

  return (
    <div className="mx-auto w-full" style={{ maxWidth: 'var(--content-width-browse)' }}>
      {/* Heading */}
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('calendar.events.title')}</h1>
      </div>

      {/* Erroring connections surface above whatever the list area shows. */}
      <CalendarReconnectBanner />

      {isLoading ? (
        /* ── Loading ── */
        <div className="space-y-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : error ? (
        /* ── Error ── */
        <div className="border border-dashed rounded-lg p-6 text-center space-y-2">
          <AlertCircle className="w-8 h-8 text-destructive mx-auto" />
          <p className="text-sm text-muted-foreground">{t('calendar.events.loadError')}</p>
        </div>
      ) : dateGroups.length === 0 ? (
        /* ── Empty state. Two distinct cases: no calendar connected (offer provider choice in
              Calendar Settings) vs connected but a quiet stretch (just say so). ── */
        <div className="border border-dashed rounded-lg p-6 text-center space-y-4">
          <CalendarDays className="w-8 h-8 text-muted-foreground mx-auto" />
          {hasConnection ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t('calendar.events.noUpcoming')}</p>
              <p className="text-xs text-muted-foreground">
                {allErroring
                  ? t('calendar.events.reconnectEmpty')
                  : t('calendar.events.connectedEmpty')}
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('calendar.events.noUpcoming')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('calendar.events.connectDescription')}
                </p>
              </div>
              <Button size="sm" variant="outline" asChild>
                <Link href="/settings/calendar">{t('calendar.events.connect')}</Link>
              </Button>
            </>
          )}
        </div>
      ) : (
        /* ── Groups ── */
        <div className="space-y-6 pb-8">
          {dateGroups.map(group => (
            <section key={group.dateKey} className="space-y-2">
              {/* Date header */}
              <h2 className="text-sm font-medium text-muted-foreground px-1">{group.label}</h2>

              {/* Meeting cards */}
              <div className="bg-muted rounded-xl overflow-hidden">
                {group.meetings.map(meeting => (
                  <div
                    key={meeting.id}
                    className="group flex flex-wrap items-start gap-3 px-4 py-3 transition-colors hover:bg-accent"
                  >
                    {/* Calendar color accent bar */}
                    <span
                      className="mt-0.5 h-8 w-1.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: meeting.calendarColor }}
                    />

                    {/* Event info */}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground">
                        {formatApplicationEventTimeRange(
                          new Date(meeting.start),
                          new Date(meeting.end),
                          meeting.isAllDay ?? false,
                          resolvedLocale,
                          t
                        )}
                      </p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium leading-tight">{meeting.title}</p>
                        <MeetingIcon joinUrl={meeting.joinUrl} />
                      </div>
                      {meeting.attendees && meeting.attendees.length > 0 && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <Users className="h-3 w-3 shrink-0" aria-hidden="true" />
                          {t('calendar.events.attendeeCount', {
                            count: meeting.attendees.length,
                          })}
                        </p>
                      )}
                    </div>

                    {/* Actions: always visible on mobile, hover-reveal on larger screens */}
                    <div className="flex sm:hidden group-hover:flex items-center gap-1.5 shrink-0 self-center">
                      <Button
                        type="button"
                        size="sm"
                        disabled={noteForEvent.disabled}
                        onClick={() => noteForEvent.open(meeting.id)}
                        className="h-7 text-xs px-2.5 bg-primary text-primary-foreground hover:bg-primary/80 cursor-pointer"
                      >
                        {t('calendar.events.createNote')}
                      </Button>
                      {meeting.joinUrl ? (
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 text-xs px-2.5 bg-primary text-primary-foreground hover:bg-primary/80 cursor-pointer"
                          asChild
                        >
                          <a href={meeting.joinUrl} target="_blank" rel="noopener noreferrer">
                            {t('calendar.events.join')}
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
