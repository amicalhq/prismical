'use client';

import { useNavigation, useSearchParams } from '@prismical/app-client';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useCommandPalette } from '../shell/command-palette';
import { ShortcutHint } from '../shell/shortcut-hint';
import { NotesList } from '../components/notes-list';
import { NotesFolderPicker } from '../components/notes-folder-picker';
import { NotesTagFilter } from '../components/notes-tag-filter';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useFolders, folderSubtreeIds } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// Notes screen: search launcher, folder/tag/sort filters (state in
// searchParams via the NavigationPort), then the filtered notes list.

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

export function NotesScreen() {
  const { t } = useTranslation();
  const router = useNavigation();
  const searchParams = useSearchParams();
  const { setOpen } = useCommandPalette();

  const folderId = searchParams.get('folder');
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

  const { data: folders = [] } = useFolders();
  const folderIds = folderId ? folderSubtreeIds(folders, folderId) : undefined;

  return (
    <div className="mx-auto w-full pb-8" style={{ maxWidth: 'var(--content-width-browse)' }}>
      <h1 className="mb-6 text-xl font-bold">{t('notes.list.title')}</h1>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {/* Search */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-9 w-full shrink-0 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-muted-foreground transition-colors hover:bg-accent sm:w-48"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate whitespace-nowrap text-left">
            {t('notes.screen.search')}
          </span>
          <ShortcutHint
            shortcut="command-palette"
            className="shrink-0"
            kbdClassName="bg-background"
          />
        </button>

        {/* Folder picker (single-select combobox) */}
        <NotesFolderPicker value={folderId} onChange={id => updateParams({ folder: id })} />

        {/* Tag filter (multi-select chips combobox) */}
        <NotesTagFilter selected={tagIds} onChange={ids => updateParams({ tags: ids })} />

        {/* Sort */}
        <Select
          value={sortKey}
          onValueChange={v => {
            const [sort = 'updatedAt', sortOrder = 'desc'] = v.split('-');
            updateParams({ sort: [sort], sortOrder: [sortOrder] });
          }}
        >
          <SelectTrigger
            aria-label={t('notes.screen.sort')}
            className="h-9 w-36 shrink-0 gap-2 rounded-lg border-transparent bg-muted px-3 text-sm text-muted-foreground shadow-none transition-colors hover:bg-accent focus-visible:ring-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map(opt => {
              const Arrow = opt.icon === 'up' ? ArrowUp : ArrowDown;
              return (
                <SelectItem key={opt.value} value={opt.value}>
                  <span>
                    {opt.label === 'lastUpdated'
                      ? t('notes.screen.lastUpdated')
                      : opt.label === 'created'
                        ? t('notes.screen.created')
                        : t('notes.screen.title')}
                  </span>
                  <Arrow className="h-3 w-3 text-muted-foreground" />
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      <NotesList
        showPageHeader={false}
        folderIds={folderIds}
        tagIds={tagIds.length > 0 ? tagIds : undefined}
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
