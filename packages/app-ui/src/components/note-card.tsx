'use client';

import { AppLink as Link } from '../shell/app-link';
import { Calendar, File } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  formatApplicationDateLabel,
  formatApplicationTime,
  useApplicationLocale,
} from '@prismical/app-i18n';
import { useEvent } from '@prismical/app-client';
import type { Note } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';

interface NoteCardProps {
  note: Note;
  /** Show only the time (used in date-grouped lists where the day is implicit). */
  showTimeOnly?: boolean;
  className?: string;
}

// Faithful port of the desktop `NoteCard` row: leading emoji/file icon, title,
// and a meta line with the updated date and (when present) the linked event.
export function NoteCard({ note, showTimeOnly = false, className }: NoteCardProps) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const event = useEvent(note.eventId);
  const updatedAt = new Date(note.updatedAt);

  return (
    <Link
      href={`/notes/${note.id}`}
      className={cn(
        'group flex items-start gap-3 rounded-lg px-3 py-2 transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        className
      )}
    >
      <div className="mt-0.5 shrink-0">
        {note.emoji ? (
          <span className="text-lg leading-none">{note.emoji}</span>
        ) : (
          <File className="h-5 w-5 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight text-foreground">
          {note.title}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>
            {showTimeOnly
              ? formatApplicationTime(updatedAt, resolvedLocale)
              : formatApplicationDateLabel(updatedAt, new Date(), resolvedLocale, t)}
          </span>
          {event && (
            <>
              <span
                aria-hidden="true"
                className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground"
              />
              <span className="inline-flex min-w-0 items-center gap-1">
                <Calendar className="h-3 w-3 shrink-0" style={{ color: event.calendarColor }} />
                <span className="truncate">{event.title}</span>
              </span>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
