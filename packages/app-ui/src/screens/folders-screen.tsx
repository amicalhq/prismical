'use client';

import * as React from 'react';
import { AppLink as Link } from '../shell/app-link';
import {
  ChevronRight,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  DirectoryEmpty,
  DirectoryError,
  DirectoryListSkeleton,
  directoryRowClass,
} from '../components/directory-states';
import { FolderNameDialog } from '../shell/folder-name-dialog';
import { DeleteFolderDialog } from '../shell/delete-folder-dialog';
import { ShareDialog } from '../shell/share-dialog';
import {
  useFolders,
  useNotes,
  useCreateFolder,
  useUpdateFolder,
  useDeleteFolder,
  useFeatureFlag,
} from '@prismical/app-client';
import type { Folder as FolderModel } from '@prismical/app-contracts';
import { cn } from '../lib/utils';
import { useTranslation } from 'react-i18next';

// Folders index: the whole folder hierarchy with subtree note counts. The sidebar lists folders
// flat, so this is the only place nesting is visible. A row's chevron expands it; its name opens
// the notes list filtered to that folder (which already covers the subtree).

/** Indentation stops growing past this depth, so a deep tree can't push names off a narrow screen. */
const MAX_INDENT_DEPTH = 6;

/** Key for the synthetic root bucket. Not a folder id: ids are prefixed (`fld_`), so it can't collide. */
const ROOT_KEY = 'root';

interface FolderNode {
  folder: FolderModel;
  children: FolderNode[];
  /** Notes in this folder AND every folder under it. */
  noteCount: number;
}

const byName = (a: FolderModel, b: FolderModel) => a.name.localeCompare(b.name);

/**
 * Build the tree. Two things a naive `parentId === null` walk gets wrong, both of which would make
 * folders VANISH from the one screen meant to account for all of them:
 *   - an orphan (parent deleted, or not readable by me) is not a root, yet has no reachable parent,
 *     so the root level adopts it;
 *   - a parent cycle is reachable from no root at all, so a sweep after the walk plants whatever the
 *     walk never visited. `seen` is what keeps the recursion finite.
 */
function buildFolderTree(
  folders: FolderModel[],
  directCount: (id: string) => number
): FolderNode[] {
  const known = new Set(folders.map(folder => folder.id));
  const childrenOf = new Map<string, FolderModel[]>();
  for (const folder of folders) {
    const key = folder.parentId && known.has(folder.parentId) ? folder.parentId : ROOT_KEY;
    const siblings = childrenOf.get(key);
    if (siblings) siblings.push(folder);
    else childrenOf.set(key, [folder]);
  }

  const seen = new Set<string>();
  const node = (folder: FolderModel): FolderNode => {
    seen.add(folder.id);
    const children = build(folder.id);
    return {
      folder,
      children,
      noteCount: children.reduce((sum, child) => sum + child.noteCount, directCount(folder.id)),
    };
  };
  const build = (parentKey: string): FolderNode[] =>
    [...(childrenOf.get(parentKey) ?? [])]
      .sort(byName)
      .filter(folder => !seen.has(folder.id))
      .map(node);

  const roots = build(ROOT_KEY);
  for (const folder of [...folders].sort(byName)) {
    if (!seen.has(folder.id)) roots.push(node(folder));
  }
  return roots;
}

/** Ids to show for a search: every match, plus the ancestors needed to reach it. */
function matchingIds(nodes: FolderNode[], query: string): Set<string> {
  const out = new Set<string>();
  const walk = (node: FolderNode): boolean => {
    const selfMatch = node.folder.name.toLowerCase().includes(query);
    // Deliberately not short-circuited: every descendant is walked, or a deeper match is missed.
    const childMatch = node.children.map(walk).some(Boolean);
    if (selfMatch || childMatch) out.add(node.folder.id);
    return selfMatch || childMatch;
  };
  nodes.forEach(walk);
  return out;
}

interface Row {
  node: FolderNode;
  depth: number;
  expanded: boolean;
}

function flatten(
  nodes: FolderNode[],
  isExpanded: (id: string) => boolean,
  visible: Set<string> | null
): Row[] {
  const rows: Row[] = [];
  const walk = (list: FolderNode[], depth: number) => {
    for (const node of list) {
      if (visible && !visible.has(node.folder.id)) continue;
      const expanded = isExpanded(node.folder.id);
      rows.push({ node, depth, expanded });
      if (expanded) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

export function FoldersScreen() {
  const { t } = useTranslation();
  const foldersQuery = useFolders();
  const notesQuery = useNotes();
  const { enabled: sharingEnabled } = useFeatureFlag('sharing');

  const [search, setSearch] = React.useState('');
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [createOpen, setCreateOpen] = React.useState(false);
  const [renameFolder, setRenameFolder] = React.useState<{ id: string; name: string } | null>(null);
  const [deleteFolder, setDeleteFolder] = React.useState<{ id: string; name: string } | null>(null);
  const [shareFolder, setShareFolder] = React.useState<{ id: string; name: string } | null>(null);

  const createFolder = useCreateFolder();
  const favoriteFolder = useUpdateFolder();
  const renameFolderMut = useUpdateFolder();
  const deleteFolderMut = useDeleteFolder();

  const folders = foldersQuery.data;
  const notes = notesQuery.data;

  const tree = React.useMemo(() => {
    const direct = new Map<string, number>();
    for (const note of notes ?? []) {
      if (note.folderId) direct.set(note.folderId, (direct.get(note.folderId) ?? 0) + 1);
    }
    return buildFolderTree(folders ?? [], id => direct.get(id) ?? 0);
  }, [folders, notes]);
  const query = search.trim().toLowerCase();
  const visible = React.useMemo(() => (query ? matchingIds(tree, query) : null), [tree, query]);
  const seededSearch = React.useRef({ query: '', ids: new Set<string>() });
  // Reveal newly loaded matches once per search. Later data changes must not undo a manual collapse.
  React.useEffect(() => {
    if (seededSearch.current.query !== query) {
      seededSearch.current = { query, ids: new Set() };
    }
    if (!visible) return;
    const added = [...visible].filter(id => !seededSearch.current.ids.has(id));
    if (added.length === 0) return;
    for (const id of added) seededSearch.current.ids.add(id);
    setExpanded(current => new Set([...current, ...added]));
  }, [query, visible]);
  const rows = flatten(tree, id => expanded.has(id), visible);

  const toggle = (id: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="mx-auto w-full" style={{ maxWidth: 'var(--content-width-browse)' }}>
      <h1 className="mb-6 text-xl font-bold">{t('folders.title')}</h1>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('folders.search')}
            className="pl-8"
          />
        </div>
        <Button variant="outline" className="shrink-0" disabled={foldersQuery.isLoading} onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t('folders.new')}
        </Button>
      </div>

      {/* Counts come from the notes collection, which settles separately — showing the tree before
          it lands would paint every folder "0 notes" and then correct itself. */}
      {foldersQuery.isLoading || notesQuery.isLoading ? (
        <DirectoryListSkeleton />
      ) : (foldersQuery.error && tree.length === 0) || (notesQuery.error && !notes) ? (
        <DirectoryError />
      ) : rows.length === 0 ? (
        <DirectoryEmpty
          icon={Folder}
          title={query ? t('folders.noMatch') : t('folders.empty')}
          hint={query ? undefined : t('folders.emptyHint')}
        />
      ) : (
        // The indent step shrinks on narrow screens, and past MAX_INDENT_DEPTH it stops growing —
        // names and counts keep their room however deep the tree runs.
        <div className="[--folder-indent:0.75rem] sm:[--folder-indent:1.25rem]">
          {rows.map(({ node, depth, expanded: isOpen }) => {
            const { folder, children, noteCount } = node;
            return (
              <div
                key={folder.id}
                className={cn(directoryRowClass, 'gap-2')}
                style={{
                  paddingInlineStart: `calc(0.75rem + var(--folder-indent) * ${Math.min(
                    depth,
                    MAX_INDENT_DEPTH
                  )})`,
                }}
              >
                {/* The folder icon IS the toggle: it turns into a chevron on hover, so a row spends
                    no width on a separate control — and in a list where most folders hold nothing,
                    an always-drawn chevron column is blank on nearly every row.

                    Two cases keep the chevron drawn without a pointer: an expanded row, where a
                    folder icon sitting above indented children reads as broken; and a touch screen,
                    which has no hover to reveal it at all. A folder with nothing inside keeps its
                    icon and is not a button, so hovering also answers "does this have children?". */}
                {children.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => toggle(folder.id)}
                    aria-expanded={isOpen}
                    aria-label={
                      isOpen
                        ? t('folders.collapse', { name: folder.name })
                        : t('folders.expand', { name: folder.name })
                    }
                    className="group/toggle -m-1 shrink-0 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Folder
                      className={cn(
                        'size-4',
                        isOpen
                          ? 'hidden'
                          : 'group-hover:hidden group-focus-within:hidden [@media(hover:none)]:hidden'
                      )}
                    />
                    <ChevronRight
                      className={cn(
                        'size-4 transition-transform',
                        isOpen
                          ? 'rotate-90'
                          : 'hidden group-hover:block group-focus-within:block [@media(hover:none)]:block'
                      )}
                    />
                  </button>
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                )}
                <Link
                  href={`/notes?folder=${folder.id}`}
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                >
                  {folder.name}
                </Link>
                {folder.favorite ? (
                  <Star className="size-3 shrink-0 fill-yellow-400 text-yellow-400" />
                ) : null}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('folders.noteCount', { count: noteCount })}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('folders.options', { name: folder.name })}
                      // Always drawn, not revealed on hover: it is the only way to rename, share or
                      // delete a folder, and a control you have to discover by hovering is one most
                      // people never find. Muted so a column of them recedes.
                      className="-m-1 shrink-0 cursor-pointer rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground data-[state=open]:text-foreground"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-48 rounded-lg" align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        favoriteFolder.mutate({
                          id: folder.id,
                          patch: { isFavorite: !folder.favorite },
                        })
                      }
                    >
                      <Star className="h-4 w-4" />
                      <span>
                        {folder.favorite
                          ? t('navigation.collections.removeFromFavorites')
                          : t('navigation.collections.addToFavorites')}
                      </span>
                    </DropdownMenuItem>
                    {sharingEnabled ? (
                      <DropdownMenuItem
                        onSelect={() => setShareFolder({ id: folder.id, name: folder.name })}
                      >
                        <UserPlus className="h-4 w-4" />
                        <span>{t('navigation.collections.shareFolder')}</span>
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setRenameFolder({ id: folder.id, name: folder.name })}
                    >
                      <Pencil className="h-4 w-4" />
                      <span>{t('common.actions.rename')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleteFolder({ id: folder.id, name: folder.name })}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span>{t('common.actions.delete')}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      )}

      {foldersQuery.error && tree.length > 0 ? <DirectoryError /> : null}

      {sharingEnabled && shareFolder ? (
        <ShareDialog
          resourceType="folder"
          resourceId={shareFolder.id}
          resourceTitle={shareFolder.name}
          open={!!shareFolder}
          onOpenChange={open => !open && setShareFolder(null)}
        />
      ) : null}

      <FolderNameDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mode="create"
        pending={createFolder.isPending}
        onSubmit={name => createFolder.mutate(name, { onSuccess: () => setCreateOpen(false) })}
      />

      <FolderNameDialog
        open={!!renameFolder}
        onOpenChange={open => !open && setRenameFolder(null)}
        mode="rename"
        initialName={renameFolder?.name}
        pending={renameFolderMut.isPending}
        onSubmit={name => {
          if (!renameFolder) return;
          renameFolderMut.mutate(
            { id: renameFolder.id, patch: { name } },
            { onSuccess: () => setRenameFolder(null) }
          );
        }}
      />

      <DeleteFolderDialog
        folder={deleteFolder}
        pending={deleteFolderMut.isPending}
        onCancel={() => setDeleteFolder(null)}
        onConfirm={() => {
          if (!deleteFolder) return;
          deleteFolderMut.mutate(deleteFolder.id, { onSuccess: () => setDeleteFolder(null) });
        }}
      />
    </div>
  );
}
