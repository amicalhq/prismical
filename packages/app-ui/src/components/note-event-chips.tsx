'use client';

import * as React from 'react';
import { Calendar, CalendarPlus, Check, Star, Unlink, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CalendarEvent, NoteEventLink } from '@prismical/app-contracts';
import {
  useCalendarEvents,
  useLinkNoteEvent,
  useNoteEvents,
  useSetPrimaryNoteEvent,
  useUnlinkNoteEvent,
} from '@prismical/app-client';
import {
  formatApplicationEventDateLabel,
  formatApplicationEventTimeRange,
  useApplicationLocale,
} from '@prismical/app-i18n';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../lib/utils';

const CHIP =
  'inline-flex h-[22px] max-w-full items-center gap-1 rounded-sm border border-border px-2 text-2xs font-medium transition-colors';

/**
 * The note's calendar events, as chips beside the folder and tags. One chip per link, the
 * primary first; a dashed "Add meeting" chip opens a picker over the user's own events, and
 * once one is linked the same chip reads "Add another meeting". Each chip opens the meeting's
 * details with unlink / make-primary actions. An automatic link (matched from the calendar when
 * the note was created) says so and offers "Not this meeting", which also tells the server never
 * to suggest that event for this note again.
 *
 * A link resolves to the CURRENT user's own event row; a collaborator who holds no copy of the
 * invite still sees its title and time (from the link) and cannot change it.
 */
export function NoteEventChips({ noteId, writable }: { noteId: string; writable: boolean }) {
  const { t } = useTranslation();
  const { data: links = [] } = useNoteEvents(noteId);
  const { data: events = [] } = useCalendarEvents();
  const byId = React.useMemo(() => new Map(events.map(e => [e.id, e] as const)), [events]);
  const link = useLinkNoteEvent(noteId);
  const linkedKeys = new Set(links.map(l => l.eventKey));

  return (
    <>
      {links.map(l => (
        <NoteEventChip
          key={l.eventKey}
          noteId={noteId}
          link={l}
          own={l.eventId ? byId.get(l.eventId) : undefined}
          writable={writable}
          canPromote={writable && !l.isPrimary && !!l.eventId}
        />
      ))}
      {writable && (
        <EventPicker
          events={events.filter(e => e.key && !linkedKeys.has(e.key))}
          label={links.length === 0 ? t('notes.events.add') : t('notes.events.addAnother')}
          onPick={event => link.mutate({ event })}
        />
      )}
    </>
  );
}

function NoteEventChip({
  noteId,
  link,
  own,
  writable,
  canPromote,
}: {
  noteId: string;
  link: NoteEventLink;
  own: CalendarEvent | undefined;
  writable: boolean;
  canPromote: boolean;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const [open, setOpen] = React.useState(false);
  const unlink = useUnlinkNoteEvent(noteId);
  const promote = useSetPrimaryNoteEvent(noteId);
  const title = own?.title ?? link.title;
  const start = own?.start ?? link.start;
  const end = own?.end ?? link.end ?? start;
  const joinUrl = own?.joinUrl ?? link.joinUrl;
  const color = own?.calendarColor;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={title}
          className={cn(CHIP, 'bg-muted text-muted-foreground hover:bg-accent')}
        >
          <Calendar className="h-3 w-3 shrink-0" style={color ? { color } : undefined} />
          <span className="max-w-40 truncate text-foreground">{title}</span>
          {link.isPrimary && (
            <Star className="h-2.5 w-2.5 shrink-0 fill-current opacity-60" aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" sideOffset={6} className="w-80 p-0">
        <div className="flex items-start gap-3 p-3">
          <span
            aria-hidden="true"
            className="mt-0.5 h-8 w-1.5 shrink-0 rounded-sm"
            style={{ backgroundColor: color ?? 'var(--muted-foreground)' }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{title}</p>
            {start && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatApplicationEventDateLabel(
                  new Date(start),
                  own?.isAllDay ?? false,
                  new Date(),
                  resolvedLocale,
                  t
                )}{' '}
                <span aria-hidden="true">•</span>{' '}
                {formatApplicationEventTimeRange(
                  new Date(start),
                  new Date(end ?? start),
                  own?.isAllDay ?? false,
                  resolvedLocale,
                  t
                )}
              </p>
            )}
            {link.source === 'auto' && (
              <p className="mt-1 text-xs text-muted-foreground">{t('notes.events.autoLinked')}</p>
            )}
            {joinUrl ? (
              <a
                href={joinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Video className="h-3 w-3" aria-hidden="true" />
                {t('notes.joinMeeting')}
              </a>
            ) : null}
            {own?.attendees && own.attendees.length > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('notes.attendeeCount', { count: own.attendees.length })}
              </p>
            ) : null}
          </div>
        </div>
        {writable && (
          <div className="flex flex-wrap gap-1 border-t border-border p-2">
            {canPromote && (
              <button
                type="button"
                className={cn(CHIP, 'hover:bg-accent')}
                onClick={() => {
                  promote.mutate(link.eventKey);
                  setOpen(false);
                }}
              >
                <Star className="h-3 w-3" aria-hidden="true" />
                {t('notes.events.makePrimary')}
              </button>
            )}
            <button
              type="button"
              className={cn(CHIP, 'hover:bg-accent')}
              onClick={() => {
                unlink.mutate({ eventKey: link.eventKey, decline: link.source === 'auto' });
                setOpen(false);
              }}
            >
              <Unlink className="h-3 w-3" aria-hidden="true" />
              {link.source === 'auto' ? t('notes.events.notThisMeeting') : t('notes.events.unlink')}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Searchable picker over the user's own events, nearest to now first. */
function EventPicker({
  events,
  label,
  onPick,
}: {
  events: CalendarEvent[];
  label: string;
  onPick: (event: CalendarEvent) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const [open, setOpen] = React.useState(false);
  // The picker stays mounted between opens; a search typed for the last pick must not filter the
  // next one ("Add another" would otherwise open on "No meetings found").
  const [query, setQuery] = React.useState('');
  const now = Date.now();
  const sorted = React.useMemo(
    () =>
      [...events].sort(
        (a, b) =>
          Math.abs(new Date(a.start).getTime() - now) - Math.abs(new Date(b.start).getTime() - now)
      ),
    [events, now]
  );

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(CHIP, 'border-dashed text-muted-foreground hover:bg-accent')}
        >
          <CalendarPlus className="h-3 w-3 shrink-0" />
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter>
          <CommandInput placeholder={t('notes.events.search')} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{t('notes.events.notFound')}</CommandEmpty>
            <CommandGroup>
              {sorted.map(event => (
                <CommandItem
                  key={event.id}
                  value={`${event.title} ${event.id}`}
                  keywords={[event.title]}
                  onSelect={() => {
                    onPick(event);
                    // Closing from code bypasses onOpenChange, so clear the search here too.
                    setOpen(false);
                    setQuery('');
                  }}
                  className="flex items-center gap-2"
                >
                  <Check className="h-4 w-4 shrink-0 opacity-0" aria-hidden="true" />
                  <Calendar
                    className="h-4 w-4 shrink-0"
                    style={{ color: event.calendarColor }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{event.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatApplicationEventDateLabel(
                      new Date(event.start),
                      event.isAllDay ?? false,
                      new Date(),
                      resolvedLocale,
                      t
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
