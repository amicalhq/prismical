'use client';

import * as React from 'react';

import { AppLink as Link } from '../shell/app-link';
import { Calendar, File, Folder } from 'lucide-react';
import { cn } from '../lib/utils';
import { formatApplicationTimeAgoShort, useApplicationLocale } from '@prismical/app-i18n';
import { useCalendarEvents, useFolders, useNoteEvents, useTags } from '@prismical/app-client';
import type { Note } from '@prismical/app-contracts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { TagBadge } from '../shell/tag-chip';
import { chipBudget } from '../lib/note-chip-budget';
import { relativeTickInterval, useNow } from '../hooks/use-now';
import { useTranslation } from 'react-i18next';

interface NoteCardProps {
  note: Note;
  className?: string;
}

/**
 * The chip shell the note page uses for its folder and meeting chips (note-folder-chip.tsx,
 * note-event-chips.tsx). Same shell here, minus their interactive states — the row itself is the
 * link — so a folder or a meeting looks the same wherever you meet it.
 */
const CHIP =
  'inline-flex h-[22px] min-w-0 shrink-0 items-center gap-1 rounded-sm border px-2 text-2xs font-medium';

/**
 * The count of what did not fit, and a popover holding those chips themselves — the colours are how
 * a tag or a calendar is recognised, so a list of names would lose what the row was showing.
 */
function OverflowChip({
  count,
  label,
  children,
}: {
  count: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // Above the stretched link, and it swallows the click so opening the overflow never
          // doubles as navigating to the note.
          onClick={event => event.stopPropagation()}
          className={cn(
            CHIP,
            'relative z-10 cursor-pointer border-transparent bg-muted-foreground/10 text-muted-foreground',
            'hover:bg-muted-foreground/20 hover:text-foreground'
          )}
        >
          +{count}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto max-w-64 flex-wrap gap-1 p-2">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function MeetingChip({
  title,
  color,
  className,
}: {
  title: string;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(CHIP, 'border-border bg-muted text-muted-foreground', className)}
      title={title}
    >
      <Calendar className="size-3 shrink-0" style={color ? { color } : undefined} />
      <span className="max-w-32 truncate text-foreground">{title}</span>
    </span>
  );
}

// A note row: emoji, title, and how long ago it was touched at the right edge, over a line of
// chips — folder, every meeting, tags — which all carry the same weight, so the title stays the
// loudest thing in the row.
export function NoteCard({ note, className }: NoteCardProps) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  // Every meeting on the note, primary first — not `note.eventId`, which is only the PRIMARY link,
  // so a note attached to three meetings used to show one chip.
  const { data: eventLinks = [] } = useNoteEvents(note.id);
  const { data: calendarEvents = [] } = useCalendarEvents();
  const { data: folders = [] } = useFolders();
  const { data: allTags = [] } = useTags();
  const updatedAt = React.useMemo(() => new Date(note.updatedAt), [note.updatedAt]);
  // The age is computed at render and the sync store re-renders a row only when that row changes,
  // so the row watches the clock — but only as closely as its own label changes, and not at all
  // once the label has become a date. A tick is a re-render of every subscribed row, so a list of
  // thousands must not have every row on the minute hand for labels that read "4d" all day.
  const now = useNow(relativeTickInterval(Date.now() - updatedAt.getTime()));
  // The lookups below scan the whole folder/tag/event collections, so they are memoized: a clock
  // tick re-renders the row without changing any of them, and re-scanning per row per tick is what
  // makes a long list expensive.
  //
  // Just the folder's own name, not its full path: a nested path would spend the row's width on
  // ancestors, and the chip line already carries the meeting and the tags.
  const folder = React.useMemo(
    () => (note.folderId ? folders.find(f => f.id === note.folderId) : undefined),
    [folders, note.folderId]
  );
  // Walk tagIds, don't filter allTags — tagIds is in note-tag link order, while useTags() sorts
  // by each tag's own updatedAt (see note-tag-editor). NotesList hydrates tagIds from the
  // note-tags join; a caller that doesn't simply renders no tags.
  const tags = React.useMemo(
    () =>
      (note.tagIds ?? [])
        .map(id => allTags.find(tag => tag.id === id))
        .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined),
    [allTags, note.tagIds]
  );
  // A link carries its own snapshot of the meeting, which is what a collaborator holding no copy of
  // the invite renders from; my own event row wins where I have one, and it carries the colour.
  const events = React.useMemo(
    () =>
      eventLinks.map(link => {
        const own = link.eventId
          ? calendarEvents.find(event => event.id === link.eventId)
          : undefined;
        return { key: link.eventKey, title: own?.title ?? link.title, color: own?.calendarColor };
      }),
    [eventLinks, calendarEvents]
  );
  const hasMeta = Boolean(folder) || events.length > 0 || tags.length > 0;
  const shown = chipBudget(Boolean(folder), events.length, tags.length);
  const hiddenEvents = events.slice(shown.events);
  const hiddenTags = tags.slice(shown.tags);

  return (
    // The row is a div with the link stretched across it, not a link wrapping everything: the
    // overflow chip opens a popover, and interactive content inside an anchor is invalid markup —
    // the click would both open the popover and navigate away from the list.
    <div
      className={cn(
        'group relative flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        className
      )}
    >
      <Link
        href={`/notes/${note.id}`}
        aria-label={note.title}
        className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      />
      <div className="mt-px shrink-0">
        {note.emoji ? (
          <span className="text-xl leading-none">{note.emoji}</span>
        ) : (
          <File className="size-5 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-base font-medium leading-snug text-foreground">
            {note.title}
          </span>
          {/* Right edge, and it stays there: the compact form can't grow with the note's age. */}
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatApplicationTimeAgoShort(updatedAt, new Date(now), resolvedLocale, t)}
          </span>
        </div>
        {hasMeta && (
          // One chip line, folder and meetings ahead of the tags. `overflow-hidden` sits on the
          // line, not the chips: what the budget did not plan for still clips at the row's edge
          // rather than wrapping the row to a third line.
          <div className="mt-1.5 flex gap-1 overflow-hidden">
            {folder && (
              // Outlined, matching the note page's folder chip: a filled bg-muted +
              // text-muted-foreground chip draws the folder NAME in the placeholder colour and
              // reads as a disabled control. Just the folder's own name here, not the full path
              // the note page shows — a nested path would spend the row on ancestors.
              <span
                className={cn(CHIP, 'border-surface-raised text-foreground')}
                title={folder.name}
              >
                <Folder className="size-3 shrink-0 text-muted-foreground" />
                <span className="max-w-32 truncate">{folder.name}</span>
              </span>
            )}
            {events.slice(0, shown.events).map(event => (
              <MeetingChip key={event.key} title={event.title} color={event.color} />
            ))}
            {hiddenEvents.length > 0 && (
              <OverflowChip
                count={hiddenEvents.length}
                label={t('notes.list.moreMeetings', { count: hiddenEvents.length })}
              >
                {hiddenEvents.map(event => (
                  <MeetingChip
                    key={event.key}
                    title={event.title}
                    color={event.color}
                    className="max-w-full"
                  />
                ))}
              </OverflowChip>
            )}
            {/* The chips the note page uses, so a tag reads the same wherever you meet it. */}
            {tags.slice(0, shown.tags).map(tag => (
              <TagBadge key={tag.id} color={tag.color} name={tag.name} nameClassName="max-w-32" />
            ))}
            {hiddenTags.length > 0 && (
              <OverflowChip
                count={hiddenTags.length}
                label={t('notes.list.moreTags', { count: hiddenTags.length })}
              >
                {hiddenTags.map(tag => (
                  <TagBadge key={tag.id} color={tag.color} name={tag.name} />
                ))}
              </OverflowChip>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
