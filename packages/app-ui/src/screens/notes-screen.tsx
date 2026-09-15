'use client';

import * as React from 'react';
import { useNavigation, useSearchParams } from '@prismical/app-client';
import {
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  ArrowUpNarrowWide,
  Search,
  X,
} from 'lucide-react';
import { NotesList } from '../components/notes-list';
import { NotesHeading } from '../components/notes-heading';
import { FoldersStrip } from '../components/folders-strip';
import { NotesTagFilter } from '../components/notes-tag-filter';
import { TagsStrip } from '../components/tags-strip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { useFolders, folderSubtreeIds } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// Notes screen: the folder path as the heading, then the toolbar (search, tag pills, sort; state
// in searchParams via the NavigationPort), the folders at this level, and the filtered notes list.

type SortKey =
  | 'updatedAt-desc'
  | 'updatedAt-asc'
  | 'createdAt-desc'
  | 'createdAt-asc'
  | 'title-asc'
  | 'title-desc';

const SORT_OPTIONS: Array<{
  value: SortKey;
  label: 'lastUpdated' | 'created' | 'title';
  icon: 'up' | 'down';
}> = [
  { value: 'updatedAt-desc', label: 'lastUpdated', icon: 'down' },
  { value: 'updatedAt-asc', label: 'lastUpdated', icon: 'up' },
  { value: 'createdAt-desc', label: 'created', icon: 'down' },
  { value: 'createdAt-asc', label: 'created', icon: 'up' },
  { value: 'title-asc', label: 'title', icon: 'up' },
  { value: 'title-desc', label: 'title', icon: 'down' },
];

type Translate = ReturnType<typeof useTranslation>['t'];

function sortOption(key: SortKey) {
  return SORT_OPTIONS.find(opt => opt.value === key) ?? SORT_OPTIONS[0]!;
}

function sortLabel(t: Translate, key: SortKey): string {
  const option = sortOption(key);
  return option.label === 'lastUpdated'
    ? t('notes.screen.lastUpdated')
    : option.label === 'created'
      ? t('notes.screen.created')
      : t('notes.screen.title');
}

/** The sort and its direction in words, for the trigger's name now that the value is an icon. */
function sortDescription(t: Translate, key: SortKey): string {
  const direction =
    sortOption(key).icon === 'up' ? t('notes.screen.ascending') : t('notes.screen.descending');
  return `${sortLabel(t, key)}, ${direction}`;
}

export function NotesScreen() {
  const { t } = useTranslation();
  const router = useNavigation();
  const searchParams = useSearchParams();
  // The search here narrows the notes in view by title; it is not the global search, which the
  // sidebar and the command palette already are. Local state: a filter typed into a view is not a
  // place to link to.
  const [query, setQuery] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  const { data: folders = [], isSuccess: foldersKnown } = useFolders();
  // A folder the list does not know (deleted elsewhere, a stale bookmark) reads as the root once
  // folders have loaded, rather than an empty page with nothing on it to clear the filter. Until
  // then the id is trusted, so a fresh load inside a folder does not flash every note first.
  const requestedFolderId = searchParams.get('folder');
  const folderId =
    requestedFolderId && foldersKnown && !folders.some(folder => folder.id === requestedFolderId)
      ? null
      : requestedFolderId;
  const tagIds = searchParams.getAll('tags');
  const sortParam = searchParams.get('sort') ?? 'updatedAt';
  const orderParam = searchParams.get('sortOrder') ?? 'desc';
  const sortKey = `${sortParam}-${orderParam}` as SortKey;

  // Rebuild the query string from a partial patch and navigate.
  const updateParams = (patch: Record<string, string | string[] | null>) => {
    const params = new URLSearchParams();
    const current: Record<string, string[]> = {
      folder: folderId ? [folderId] : [],
      tags: tagIds,
      sort: searchParams.get('sort') ? [searchParams.get('sort')!] : [],
      sortOrder: searchParams.get('sortOrder') ? [searchParams.get('sortOrder')!] : [],
    };
    const merged = { ...current, ...normalizePatch(patch) };
    for (const [key, values] of Object.entries(merged)) {
      for (const v of values) params.append(key, v);
    }
    const qs = params.toString();
    router.push(qs ? `/notes?${qs}` : '/notes');
  };

  const folderIds = folderId ? folderSubtreeIds(folders, folderId) : undefined;

  return (
    <div className="mx-auto w-full pb-8" style={{ maxWidth: 'var(--content-width-browse)' }}>
      <NotesHeading folderId={folderId} />

      {/* The folders at this level come before the filters: they are the next step down from the
          heading, and the filters below narrow the list they sit on. */}
      <FoldersStrip parentId={folderId} />

      {/* Toolbar: search, the tag pills, sort. Filters only; the folder is the heading above. */}
      <div className="mb-6 flex items-center gap-2">
        {searching ? (
          <div className="flex h-9 w-56 shrink-0 items-center gap-2 rounded-lg bg-muted px-3 text-sm">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  setQuery('');
                  setSearching(false);
                }
              }}
              onBlur={() => {
                if (query.trim() === '') setSearching(false);
              }}
              aria-label={t('notes.screen.searchHere')}
              placeholder={t('notes.screen.searchHere')}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                aria-label={t('notes.screen.clearSearch')}
                className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSearching(true)}
            aria-label={t('notes.screen.searchHere')}
            title={t('notes.screen.searchHere')}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:bg-accent"
          >
            <Search className="size-4" />
          </button>
        )}

        {/* One line of toggle pills where there is room; on a narrow screen the same filter folds
            back into a single Tags button that opens the searchable list. */}
        <TagsStrip
          className="hidden sm:flex"
          selected={tagIds}
          folderIds={folderIds}
          onChange={ids => updateParams({ tags: ids })}
        />
        <div className="flex min-w-0 flex-1 sm:hidden">
          <NotesTagFilter selected={tagIds} onChange={ids => updateParams({ tags: ids })} />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${t('notes.screen.sort')}: ${sortDescription(t, sortKey)}`}
              title={sortDescription(t, sortKey)}
              className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:bg-accent data-[state=open]:bg-accent"
            >
              {/* The direction is the one thing the icon can say, so it does. */}
              {sortOption(sortKey).icon === 'up' ? (
                <ArrowUpNarrowWide className="size-4" />
              ) : (
                <ArrowDownWideNarrow className="size-4" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuRadioGroup
              value={sortKey}
              onValueChange={v => {
                const [sort = 'updatedAt', sortOrder = 'desc'] = v.split('-');
                updateParams({ sort: [sort], sortOrder: [sortOrder] });
              }}
            >
              {SORT_OPTIONS.map(opt => {
                const Arrow = opt.icon === 'up' ? ArrowUp : ArrowDown;
                return (
                  <DropdownMenuRadioItem
                    key={opt.value}
                    value={opt.value}
                    aria-label={sortDescription(t, opt.value)}
                  >
                    <span className="flex-1">{sortLabel(t, opt.value)}</span>
                    <Arrow className="size-3 text-muted-foreground" />
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <NotesList
        showPageHeader={false}
        folderIds={folderIds}
        folderId={folderId}
        tagIds={tagIds.length > 0 ? tagIds : undefined}
        query={query}
        sortBy={sortParam as 'updatedAt' | 'createdAt' | 'title'}
        sortOrder={orderParam as 'asc' | 'desc'}
      />
    </div>
  );
}

// Patch values arrive as string | string[] | null; normalize to string[] (with
// `null` meaning "remove the key").
function normalizePatch(patch: Record<string, string | string[] | null>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) out[key] = [];
    else if (Array.isArray(value)) out[key] = value;
    else out[key] = [value];
  }
  return out;
}
