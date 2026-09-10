'use client';

import { AppLink as Link } from '../shell/app-link';
import { Calendar, File, Folder } from 'lucide-react';
import { cn } from '../lib/utils';
import { formatApplicationTimeAgoShort, useApplicationLocale } from '@prismical/app-i18n';
import { useEvent, useFolders, useTags } from '@prismical/app-client';
import type { Note } from '@prismical/app-contracts';
import { TagBadge } from '../shell/tag-chip';
import { useNow } from '../hooks/use-now';
import { useTranslation } from 'react-i18next';

interface NoteCardProps {
  note: Note;
  className?: string;
}

// A note row: emoji, title, and how long ago it was touched at the right edge, over a line of
// chips — folder, meeting, tags — which all carry the same weight, so the title stays the loudest
// thing in the row.
export function NoteCard({ note, className }: NoteCardProps) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  // Ticks once a minute: the age is computed at render, and the sync store re-renders a row only
  // when that row changes, so a list left open would otherwise keep the age it first painted.
  const now = useNow();
  const event = useEvent(note.eventId);
  const { data: folders = [] } = useFolders();
  const { data: allTags = [] } = useTags();
  const updatedAt = new Date(note.updatedAt);
  // Just the folder's own name, not its full path: a nested path would spend the row's width on
  // ancestors, and the chip line already carries the meeting and the tags.
  const folder = note.folderId ? folders.find(f => f.id === note.folderId) : undefined;
  // Walk tagIds, don't filter allTags — tagIds is in note-tag link order, while useTags() sorts
  // by each tag's own updatedAt (see note-tag-editor). NotesList hydrates tagIds from the
  // note-tags join; a caller that doesn't simply renders no tags.
  const tags = (note.tagIds ?? [])
    .map(id => allTags.find(tag => tag.id === id))
    .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined);
  const hasMeta = Boolean(folder) || Boolean(event) || tags.length > 0;

  return (
    <Link
      href={`/notes/${note.id}`}
      className={cn(
        'group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        className
      )}
    >
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
          // One chip line, folder and meeting ahead of the tags. `overflow-hidden` sits on the
          // line, not the chips: a note carrying a folder, a meeting and ten tags clips at the
          // row's edge instead of wrapping the row to a third line.
          <div className="mt-1.5 flex gap-1 overflow-hidden">
            {folder && (
              // Outlined, matching the note page's folder chip: a filled bg-muted +
              // text-muted-foreground chip draws the folder NAME in the placeholder colour and
              // reads as a disabled control. Just the folder's own name here, not the full path
              // the note page shows — a nested path would spend the row on ancestors.
              <span className={cn(CHIP, 'border-surface-raised text-foreground')} title={folder.name}>
                <Folder className="size-3 shrink-0 text-muted-foreground" />
                <span className="max-w-32 truncate">{folder.name}</span>
              </span>
            )}
            {event && (
              // The note page's meeting chip: muted fill, the calendar's colour on the icon, and
              // the title itself in the foreground colour.
              <span
                className={cn(CHIP, 'border-border bg-muted text-muted-foreground')}
                title={event.title}
              >
                <Calendar
                  className="size-3 shrink-0"
                  style={event.calendarColor ? { color: event.calendarColor } : undefined}
                />
                <span className="max-w-32 truncate text-foreground">{event.title}</span>
              </span>
            )}
            {/* The chips the note page uses, so a tag reads the same wherever you meet it. */}
            {tags.map(tag => (
              <TagBadge key={tag.id} color={tag.color} name={tag.name} nameClassName="max-w-32" />
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

/**
 * The chip shell the note page uses for its folder and meeting chips (note-folder-chip.tsx,
 * note-event-chips.tsx). Same shell here, minus their interactive states — in a list row the whole
 * row is the link — so a folder or a meeting looks the same wherever you meet it.
 */
const CHIP =
  'inline-flex h-[22px] min-w-0 shrink-0 items-center gap-1 rounded-sm border px-2 text-2xs font-medium';
