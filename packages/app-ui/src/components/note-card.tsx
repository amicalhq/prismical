'use client';

import * as React from 'react';

import { AppLink as Link } from '../shell/app-link';
import { Calendar, File, Folder, Star } from 'lucide-react';
import { cn } from '../lib/utils';
import { formatApplicationTimeAgoShort, useApplicationLocale } from '@prismical/app-i18n';
import { useCalendarEvents, useFolders, useNoteEvents, useTags } from '@prismical/app-client';
import type { Note } from '@prismical/app-contracts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { TagBadge } from '../shell/tag-chip';
import { meetingBudget, tagBudget } from '../lib/note-chip-budget';
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
 * The height of the title line, and of the emoji beside it. Both are given the SAME box and centre
 * their content in it, so the title sits level with the emoji whether or not the note carries a
 * tag: text-sm is 17.5px tall and a chip is 22px, so a line that just wrapped its content moved
 * the title up by a couple of pixels the moment a row had no tags on it. 22px is the chip's own
 * height, so the line doesn't change size when tags appear.
 *
 * A floor, NOT a fixed height. The text inside is rem-sized while this is px, so a reader who
 * raises the browser's default font size grows the title past any hard height: at a 24px root the
 * title's box is 26.3px, and at 32px it is 35px and would sit on top of the metadata chips below.
 * min-height keeps the alignment at the default size and lets the line grow past it.
 */
const LINE = 'min-h-[22px]';

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

/**
 * The favorite star, drawn only on a note that IS one. An indicator, not a control: the row's
 * whole surface is the link to the note, and a single stray click on a control here would drop a
 * favorite with nothing in the row to undo it. Favoriting is done from the note itself or the
 * sidebar's row menu.
 *
 * The folder and tag rows DO carry a clickable star, hollow on every row. Those lists are short
 * and the star is the only way to favorite from them; a note list runs to hundreds of rows, where
 * a column of hollow stars is noise against the handful that mean something.
 */
function FavoriteStar() {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t('navigation.collections.favorited')}
      className="flex size-[22px] items-center justify-center"
    >
      <Star className="size-3.5 fill-yellow-400 text-yellow-400" />
    </span>
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

// A note row: emoji, title with its tags, and how long ago it was touched at the right edge —
// over a metadata line carrying the folder and every meeting, and only when the note has one.
// Tags sit with the title because they name what the note is about; the folder and the meeting
// say where it came from, which is the quieter question.
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
  // ancestors, and the metadata line already carries the meetings.
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
  const hasMeta = Boolean(folder) || events.length > 0;
  const shownEvents = meetingBudget(events.length);
  const shownTags = tagBudget(tags.length);
  const hiddenEvents = events.slice(shownEvents);
  const hiddenTags = tags.slice(shownTags);

  return (
    // The row is a div with the link stretched across it, not a link wrapping everything: the
    // overflow chip opens a popover, and interactive content inside an anchor is invalid markup —
    // the click would both open the popover and navigate away from the list.
    <div
      className={cn(
        'group relative flex items-start gap-3 rounded-lg px-3 py-2 transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        className
      )}
    >
      <Link
        href={`/notes/${note.id}`}
        aria-label={note.title}
        className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      />
      {/* Centred in the title line's box rather than hung from the top of the row — see LINE. */}
      <div className={cn('flex shrink-0 items-center', LINE)}>
        {note.emoji ? (
          <span className="text-xl leading-none">{note.emoji}</span>
        ) : (
          <File className="size-5 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className={cn('flex items-center gap-2', LINE)}>
          {/* No flex-1: the title takes only the width it needs, so its tags follow the NAME
              rather than being pushed out to the age at the far edge.
              `truncate` sets overflow:hidden, which drops a flex item's automatic minimum size to
              zero — so the title needs a floor of its own or a narrow row squeezes it out of
              existence and leaves the note with no visible name at all. 4ch is small enough that
              a short title still sits right against its tags. */}
          <span className="min-w-[4ch] truncate text-sm font-medium leading-tight text-foreground">
            {note.title}
          </span>
          {tags.length > 0 && (
            // Shrinkable, so the tags give way with the title rather than shoving the star and the
            // age off the row's right edge — `min-w-0` is what lets it shrink below its chips, and
            // only then does `overflow-hidden` clip them at the row's edge. Left un-shrinkable this
            // pushed the age clean outside the row on a narrow column.
            <div className="flex min-w-0 items-center gap-1 overflow-hidden">
              {/* The chips the note page uses, so a tag reads the same wherever you meet it. */}
              {tags.slice(0, shownTags).map(tag => (
                <TagBadge key={tag.id} color={tag.color} name={tag.name} nameClassName="max-w-24" />
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
          {/* The row's trailing edge, and it stays there: the age's compact form can't grow as
              the note gets older, so the star keeps one column all the way down the list. */}
          <div className="ml-auto flex shrink-0 items-center gap-1 pl-1">
            {/* The star's box is held whether or not the note is a favorite: without it the age
                would sit 22px further right on a favorited row, and the column of dates would
                jitter down a list where only a few notes are starred. */}
            {note.starred ? <FavoriteStar /> : <span className="size-[22px]" />}
            <span className="text-xs text-muted-foreground">
              {formatApplicationTimeAgoShort(updatedAt, new Date(now), resolvedLocale, t)}
            </span>
          </div>
        </div>
        {hasMeta && (
          // Where the note came from: its folder, then its meetings. `overflow-hidden` sits on
          // the line, not the chips: what the budget did not plan for still clips at the row's
          // edge rather than wrapping the row to a third line.
          <div className="mt-1 flex gap-1 overflow-hidden">
            {folder && (
              // Outlined, matching the note page's folder chip: a filled bg-muted +
              // text-muted-foreground chip draws the folder NAME in the placeholder colour and
              // reads as a disabled control. The outline is --border, NOT --surface-raised: in
              // light that token is #fcfcfd, the exact value of --background, so the chip lost its
              // shape entirely and only dark kept an edge. Just the folder's own name here, not the
              // full path the note page shows — a nested path would spend the row on ancestors.
              <span className={cn(CHIP, 'border-border text-foreground')} title={folder.name}>
                <Folder className="size-3 shrink-0 text-muted-foreground" />
                <span className="max-w-32 truncate">{folder.name}</span>
              </span>
            )}
            {events.slice(0, shownEvents).map(event => (
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
          </div>
        )}
      </div>
    </div>
  );
}
