'use client';

import { NotebookText } from 'lucide-react';
import { NoteCard } from './note-card';
import { DataError } from './data-error';
import { NoteListSkeleton, NoteGroupsSkeleton } from './skeletons';
import type { Note } from '@prismical/app-contracts';
import { useNotes } from '@prismical/app-client';
import { useAllNoteTags } from '@prismical/app-client';
import { groupNotesByDate } from '../lib/note-date-groups';
import { useTranslation } from 'react-i18next';
import { useApplicationLocale } from '@prismical/app-i18n';

interface NotesListProps {
  showPageHeader?: boolean;
  groupByDate?: boolean;
  /** Restrict to notes whose folderId is one of these. */
  folderIds?: string[];
  /** Restrict to notes that carry ALL of these tags. */
  tagIds?: string[];
  sortBy?: 'updatedAt' | 'createdAt' | 'title';
  sortOrder?: 'asc' | 'desc';
}

function sortNotes(
  list: Note[],
  sortBy: NotesListProps['sortBy'],
  sortOrder: NotesListProps['sortOrder'],
  locale: string
): Note[] {
  const dir = sortOrder === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(locale);
  return [...list].sort((a, b) => {
    if (sortBy === 'title') return collator.compare(a.title, b.title) * dir;
    const aDate = sortBy === 'createdAt' ? a.createdAt ?? a.updatedAt : a.updatedAt;
    const bDate = sortBy === 'createdAt' ? b.createdAt ?? b.updatedAt : b.updatedAt;
    return (new Date(aDate).getTime() - new Date(bDate).getTime()) * dir;
  });
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 rounded-lg border border-dashed p-6 text-center">
      <NotebookText className="mx-auto h-8 w-8 text-muted-foreground" />
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t('notes.list.emptyTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('notes.list.emptyDescription')}</p>
      </div>
    </div>
  );
}

// Filters/sorts live notes and renders `NoteCard` rows, optionally under date headings
// (see lib/note-date-groups.ts for the buckets).
export function NotesList({
  showPageHeader = true,
  groupByDate = false,
  folderIds,
  tagIds,
  sortBy = 'updatedAt',
  sortOrder = 'desc',
}: NotesListProps) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const notesQuery = useNotes();
  const { data: liveNotes = [], isLoading } = notesQuery;
  const noteTagsQuery = useAllNoteTags();
  const { data: noteTags = [] } = noteTagsQuery;
  const filteringTags = Boolean(tagIds?.length);

  if (isLoading || (filteringTags && noteTagsQuery.isLoading)) {
    // Same -mx-3 as the loaded list, so rows don't shift 12px left on load.
    return (
      <div className="-mx-3">{groupByDate ? <NoteGroupsSkeleton /> : <NoteListSkeleton />}</div>
    );
  }
  if (notesQuery.error) {
    return (
      <DataError message={t('notes.list.loadError')} onRetry={() => void notesQuery.refetch()} />
    );
  }
  if (filteringTags && noteTagsQuery.error) {
    return (
      <DataError message={t('notes.list.loadError')} onRetry={() => void noteTagsQuery.refetch()} />
    );
  }

  // Hydrate each note's tagIds from the note-tags join table (the list endpoint
  // returns tagIds: [] — tags only come from GET /me/note-tags).
  const tagsByNote = new Map<string, string[]>();
  for (const { noteId, tagId } of noteTags) {
    const arr = tagsByNote.get(noteId) ?? [];
    arr.push(tagId);
    tagsByNote.set(noteId, arr);
  }
  const allNotes = liveNotes.map(n => ({ ...n, tagIds: tagsByNote.get(n.id) ?? [] }));

  const filtered = allNotes.filter(note => {
    if (folderIds && folderIds.length > 0) {
      if (!note.folderId || !folderIds.includes(note.folderId)) return false;
    }
    if (tagIds && tagIds.length > 0) {
      if (!tagIds.every(id => note.tagIds.includes(id))) return false;
    }
    return true;
  });

  const sorted = sortNotes(filtered, sortBy, sortOrder, resolvedLocale);

  // Date headings only make sense over a date order — a title sort would interleave the buckets
  // and repeat their headings all the way down the list.
  if (groupByDate && sortBy !== 'title') {
    if (sorted.length === 0) return <EmptyState />;
    const groups = groupNotesByDate(
      sorted,
      note => new Date(sortBy === 'createdAt' ? note.createdAt ?? note.updatedAt : note.updatedAt),
      new Date(),
      resolvedLocale,
      t
    );

    return (
      // -mx-3 cancels the px-3 the rows and group headings carry for their hover
      // pill, so this column's text lines up with the greeting and the meetings
      // header above it while the highlight still bleeds past the content edge.
      <div className="-mx-3 space-y-6">
        {groups.map(group => (
          <section key={group.key} className="space-y-2">
            <h2 className="px-3 text-sm font-medium text-muted-foreground">{group.label}</h2>
            <div>
              {group.notes.map(note => (
                <NoteCard key={note.id} note={note} />
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }

  if (sorted.length === 0) return <EmptyState />;

  return (
    <div>
      {showPageHeader && (
        <div className="mb-8">
          <h1 className="text-xl font-bold">{t('notes.list.title')}</h1>
        </div>
      )}
      {/* See the grouped branch: -mx-3 keeps the row text flush with the header
          and filter row above, which carry no horizontal padding. */}
      <div className="-mx-3">
        {sorted.map(note => (
          <NoteCard key={note.id} note={note} />
        ))}
      </div>
    </div>
  );
}
