'use client';

import * as React from 'react';
import { AppLink as Link } from '../shell/app-link';
import { ArrowDownWideNarrow, Hash, MoreHorizontal, Pencil, Plus, Search, Star, Trash2 } from 'lucide-react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  DirectoryEmpty,
  DirectoryError,
  DirectoryListSkeleton,
  directoryRowClass,
} from '../components/directory-states';
import { TagHash } from '../shell/tag-chip';
import { TagEditDialog } from '../shell/tag-edit-dialog';
import { DeleteTagDialog } from '../shell/delete-tag-dialog';
import {
  nextAutoColor,
  useAllNoteTags,
  useCreateTag,
  useDeleteTag,
  useTags,
  useUpdateTag,
} from '@prismical/app-client';
import type { Tag } from '@prismical/app-contracts';
import { cn } from '../lib/utils';
import { useTranslation } from 'react-i18next';

// Tags index: every tag, with how many notes carry it. The sidebar shows only the five newest plus
// whatever is favorited, so this is the only place an older tag can be renamed, recolored or
// deleted at all. Flat by design — tags don't nest, which is what separates this from the folders
// screen it otherwise mirrors.

type SortKey = 'name' | 'count';

interface TagRow {
  tag: Tag;
  noteCount: number;
}

/** Name order is for finding a tag you can name; count order is for finding the ones to prune. */
function sortRows(rows: TagRow[], sort: SortKey): TagRow[] {
  const byName = (a: TagRow, b: TagRow) => a.tag.name.localeCompare(b.tag.name);
  if (sort === 'name') return [...rows].sort(byName);
  // Ties on count fall back to name, so the order is stable rather than whatever the store handed
  // back — otherwise a list of mostly-zero tags reshuffles on any unrelated edit.
  return [...rows].sort((a, b) => b.noteCount - a.noteCount || byName(a, b));
}

export function TagsScreen() {
  const { t } = useTranslation();
  const tagsQuery = useTags();
  const noteTagsQuery = useAllNoteTags();

  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<SortKey>('name');
  const [favoritesOnly, setFavoritesOnly] = React.useState(false);
  const favoritesToggleRef = React.useRef<HTMLButtonElement>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTagId, setEditTagId] = React.useState<string | null>(null);
  const [deleteTag, setDeleteTag] = React.useState<{ id: string; name: string } | null>(null);

  const createTag = useCreateTag();
  // Separate instances so a background favorite-toggle can't gate the edit dialog's `pending`.
  const favoriteTag = useUpdateTag();
  const editTagMut = useUpdateTag();
  const deleteTagMut = useDeleteTag();

  const tags = tagsQuery.data;
  const tagsAvailable = !tagsQuery.isLoading && tags !== undefined;
  const createUnavailable = !tagsAvailable || createTag.isPending;
  React.useEffect(() => {
    if (!tagsAvailable) setCreateOpen(false);
  }, [tagsAvailable]);
  const noteTags = noteTagsQuery.data;

  // Resolved from the live collection every render, never held as a snapshot: a tag deleted on
  // another device mid-edit leaves the store, and saving a snapshot would write the row back —
  // `renameTag` assigns into `tags$[id]` without checking it is still there, resurrecting the tag
  // as a row with no id and no color.
  const editTag = React.useMemo(
    () => (editTagId ? ((tags ?? []).find(tag => tag.id === editTagId) ?? null) : null),
    [tags, editTagId]
  );

  const rows = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const { tagId } of noteTags ?? []) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    return (tags ?? []).map(tag => ({ tag, noteCount: counts.get(tag.id) ?? 0 }));
  }, [tags, noteTags]);

  const query = search.trim().toLowerCase();
  const visible = React.useMemo(() => {
    const matched = rows.filter(
      row =>
        (!query || row.tag.name.toLowerCase().includes(query)) &&
        (!favoritesOnly || row.tag.favorite)
    );
    return sortRows(matched, sort);
  }, [rows, query, favoritesOnly, sort]);

  // What a new tag would have been colored had the name been typed on a note, so creating from
  // either place walks the palette the same way.
  const suggestedColor = React.useMemo(
    () => nextAutoColor((tags ?? []).map(tag => tag.color)),
    [tags]
  );
  const takenNames = React.useMemo(() => (tags ?? []).map(tag => tag.name), [tags]);

  // A filter that matches nothing is not the same as having no tags: say which one it is, or the
  // page reads as if the tags were lost.
  const filtered = Boolean(query) || favoritesOnly;

  return (
    <div className="mx-auto w-full" style={{ maxWidth: 'var(--content-width-browse)' }}>
      <h1 className="mb-6 text-xl font-bold">{t('tags.title')}</h1>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('tags.search')}
            className="pl-8"
          />
        </div>
        {/* Filters, not a sort: pressing the star narrows the list instead of reordering it, so it
            composes with whichever order is selected. */}
        <Button
          ref={favoritesToggleRef}
          variant={favoritesOnly ? 'secondary' : 'outline'}
          aria-pressed={favoritesOnly}
          className="shrink-0"
          onClick={() => setFavoritesOnly(current => !current)}
        >
          <Star className={cn('size-4', favoritesOnly && 'fill-yellow-400 text-yellow-400')} />
          {t('tags.favoritesOnly')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="shrink-0">
              <ArrowDownWideNarrow className="size-4" />
              {sort === 'name' ? t('tags.sortByName') : t('tags.sortByCount')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44 rounded-lg">
            <DropdownMenuRadioGroup value={sort} onValueChange={next => setSort(next as SortKey)}>
              <DropdownMenuRadioItem value="name">{t('tags.sortByName')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="count">{t('tags.sortByCount')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Until the tags land, `takenNames` is empty and the collision guard would pass on a name
            that already exists — the create then 409s and reverts, losing the color just picked. */}
        <Button
          variant="outline"
          className="shrink-0"
          disabled={createUnavailable}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-4" />
          {t('tags.new')}
        </Button>
      </div>

      {/* Counts come from the note-tag join, which settles separately — showing the list before it
          lands would paint every tag "No notes" and then correct itself. */}
      {tagsQuery.isLoading || noteTagsQuery.isLoading ? (
        <DirectoryListSkeleton />
      ) : tagsQuery.error || noteTagsQuery.error ? (
        // Not just the tags lane: without the note links every tag reads "No notes", which is the
        // cue this screen offers for deleting one. Better no list than a list that invites pruning
        // tags that are in use.
        <DirectoryError />
      ) : visible.length === 0 ? (
        <DirectoryEmpty
          icon={Hash}
          title={filtered ? t('tags.noMatch') : t('tags.empty')}
          hint={filtered ? undefined : t('tags.emptyHint')}
        />
      ) : (
        <div>
          {visible.map(({ tag, noteCount }) => (
            <div key={tag.id} className={cn(directoryRowClass, 'gap-2')}>
              {/* The hash form, not the tinted badge: the badge is for a tag sitting inside other
                  content, where it has to read as an object. In a list where every row is a tag the
                  tint is noise — same reason the sidebar rows use the hash. */}
              <Link href={`/notes?tags=${tag.id}`} className="min-w-0 flex-1">
                <TagHash color={tag.color} name={tag.name} className="font-medium" />
              </Link>
              {tag.favorite ? (
                <Star className="size-3 shrink-0 fill-yellow-400 text-yellow-400" />
              ) : null}
              {/* A tag no note carries is the main thing you would come here to delete, so it reads
                  as a state rather than as the number zero. */}
              <span
                className={cn(
                  'shrink-0 text-xs',
                  noteCount === 0 ? 'text-muted-foreground/70' : 'text-muted-foreground'
                )}
              >
                {noteCount === 0 ? t('tags.noNotes') : t('tags.noteCount', { count: noteCount })}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('tags.options', { name: tag.name })}
                    // Always drawn rather than revealed on hover: it is the only way to rename,
                    // recolor or delete a tag. Muted so a column of them recedes.
                    className="-m-1 shrink-0 cursor-pointer rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground data-[state=open]:text-foreground"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-48 rounded-lg" align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      // Un-favoriting under the favorites filter removes this very row, so the
                      // menu's trigger unmounts while Radix is restoring focus to it and the next
                      // Tab restarts from the top of the page. Hand focus to the filter that did
                      // it, after the row is gone.
                      const rowLeaves = favoritesOnly && tag.favorite;
                      favoriteTag.mutate({ id: tag.id, patch: { isFavorite: !tag.favorite } });
                      if (rowLeaves) {
                        requestAnimationFrame(() => favoritesToggleRef.current?.focus());
                      }
                    }}
                  >
                    <Star className="h-4 w-4" />
                    <span>
                      {tag.favorite
                        ? t('navigation.collections.removeFromFavorites')
                        : t('navigation.collections.addToFavorites')}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setEditTagId(tag.id)}>
                    <Pencil className="h-4 w-4" />
                    <span>{t('dialogs.tag.title')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleteTag({ id: tag.id, name: tag.name })}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>{t('common.actions.delete')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}

      <TagEditDialog
        open={createOpen}
        mode="create"
        onOpenChange={setCreateOpen}
        defaultColor={suggestedColor}
        takenNames={takenNames}
        pending={createTag.isPending}
        onSubmit={values => {
          if (createUnavailable || !values.name) return;
          createTag.mutate(
            { name: values.name, color: values.color },
            { onSuccess: () => setCreateOpen(false) }
          );
        }}
      />

      <TagEditDialog
        open={!!editTag}
        tag={editTag}
        takenNames={takenNames}
        onOpenChange={open => !open && setEditTagId(null)}
        pending={editTagMut.isPending}
        onSubmit={patch => {
          if (!editTag) return;
          editTagMut.mutate({ id: editTag.id, patch }, { onSuccess: () => setEditTagId(null) });
        }}
      />

      <DeleteTagDialog
        tag={deleteTag}
        pending={deleteTagMut.isPending}
        onCancel={() => setDeleteTag(null)}
        onConfirm={() => {
          if (!deleteTag) return;
          deleteTagMut.mutate(deleteTag.id, { onSuccess: () => setDeleteTag(null) });
        }}
      />
    </div>
  );
}
