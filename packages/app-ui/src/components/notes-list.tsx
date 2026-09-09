'use client';

import { NotebookText } from 'lucide-react';
import { NoteCard } from './note-card';
import { DataError } from './data-error';
import { NoteListSkeleton, NoteGroupsSkeleton } from './skeletons';
import type { Note } from '@prismical/app-contracts';
import { useNotes } from '@prismical/app-client';
import { useAllNoteTags } from '@prismical/app-client';
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

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
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

// Faithful port of the desktop `NotesList`. Filters/sorts live notes and
// renders `NoteCard` rows, optionally grouped into Today / Earlier sections.
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
    return groupByDate ? <NoteGroupsSkeleton /> : <NoteListSkeleton />;
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

  if (groupByDate) {
    if (sorted.length === 0) return <EmptyState />;
    const todayNotes = sorted.filter(n => isToday(new Date(n.updatedAt)));
    const earlierNotes = sorted.filter(n => !isToday(new Date(n.updatedAt)));

    return (
      <div className="space-y-6">
        {todayNotes.length > 0 && (
          <section className="space-y-2">
            <h2 className="px-3 text-sm font-medium text-muted-foreground">
              {t('notes.list.today')}
            </h2>
            <div>
              {todayNotes.map(note => (
                <NoteCard key={note.id} note={note} showTimeOnly />
              ))}
            </div>
          </section>
        )}
        {earlierNotes.length > 0 && (
          <section className="space-y-2">
            <h2 className="px-3 text-sm font-medium text-muted-foreground">
              {todayNotes.length > 0 ? t('notes.list.earlier') : t('notes.list.all')}
            </h2>
            <div>
              {earlierNotes.map(note => (
                <NoteCard key={note.id} note={note} />
              ))}
            </div>
          </section>
        )}
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
      {sorted.map(note => (
        <NoteCard key={note.id} note={note} />
      ))}
    </div>
  );
}
