'use client';

import * as React from 'react';
import { AppLink as Link } from './app-link';
import { usePathname, useNavigation, useSearchParams } from '@prismical/app-client';
import {
  Check,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  EllipsisVertical,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '../ui/sidebar';
import { TagSidebarRow } from './tag-sidebar-row';
import { NavTagsGroup } from './nav-tags-group';
import type { Note, FavoriteEntry } from '@prismical/app-contracts';
import { useFolders } from '@prismical/app-client';
import { useNotes, useUpdateNote, useDeleteNote } from '@prismical/app-client';
import { useTags } from '@prismical/app-client';
import { useAllNoteTags } from '@prismical/app-client';
import { newestFirst } from '../lib/sidebar-recent';
import { buildFolderTree, type FolderNode } from '../lib/folder-tree';
import { FolderDisclosure } from '../components/folder-disclosure';
import { dropdownMenuKit, FolderMenuItems, useFolderActions } from '../components/folder-menu';
import { useShowMore } from '../hooks/use-show-more';
import { isFolderShared } from '../lib/folder-sharing';
import { DeleteNoteDialog } from './delete-note-dialog';
import { useTranslation } from 'react-i18next';
import { withoutNotesFilter } from '../lib/notes-filter-url';

function NoteLeadingIcon({ icon }: { icon?: string }) {
  if (icon) return <span className="text-base leading-none">{icon}</span>;
  return <FileText className="size-4" />;
}

/** How many folders the sidebar starts with; "Show more" pages past it. Matches the tags group. */
const RECENT_FOLDER_LIMIT = 5;

/** Each "Show more" reveals this many further folders. */
const FOLDER_PAGE = 10;

/** Indentation stops growing past this depth, so a deep branch keeps its names readable. */
const MAX_FOLDER_INDENT = 4;

// Wired row-actions menu (favorite toggle, move-to-folder submenu, delete-with-confirm).
// Rendered from both the Favorites section and the per-folder note sub-rows; the caller supplies
// the trigger element so each row keeps its own hover affordance.
function NoteRowActions({ note, trigger }: { note: Note; trigger: React.ReactNode }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useNavigation();
  const { data: folders = [] } = useFolders();
  const updateNote = useUpdateNote(note.id);
  const deleteNote = useDeleteNote();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent className="w-56 rounded-lg" side="right" align="start">
          <DropdownMenuItem onSelect={() => updateNote.mutate({ starred: !note.starred })}>
            <Star className="h-4 w-4" />
            <span>
              {note.starred
                ? t('navigation.collections.removeFromFavorites')
                : t('navigation.collections.addToFavorites')}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderIcon className="h-4 w-4" />
              <span>{t('navigation.collections.moveToFolder')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
              {note.folderId && (
                <>
                  {/* Passing folderId: undefined writes NULL via noteUpdateBody (un-folder). */}
                  <DropdownMenuItem onSelect={() => updateNote.mutate({ folderId: undefined })}>
                    <span>{t('navigation.collections.removeFromFolder')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {sortedFolders.length === 0 ? (
                <DropdownMenuItem disabled>
                  {t('navigation.collections.noFolders')}
                </DropdownMenuItem>
              ) : (
                sortedFolders.map(f => (
                  <DropdownMenuItem
                    key={f.id}
                    disabled={f.id === note.folderId}
                    onSelect={() => updateNote.mutate({ folderId: f.id })}
                  >
                    <FolderIcon className="h-4 w-4" />
                    <span className="flex-1 truncate">{f.name}</span>
                    {f.id === note.folderId && <Check className="ml-2 h-4 w-4 shrink-0" />}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4" />
            <span>{t('common.actions.delete')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteNoteDialog
        note={deleteOpen ? { id: note.id, title: note.title } : null}
        pending={deleteNote.isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          // Navigate SYNCHRONOUSLY, not in mutate()'s onSuccess: useDeleteNote is optimistic, so
          // onMutate drops the note from cache and unmounts this row (and its mutation observer)
          // before the request resolves — the mutate-level callback would never fire. Leaving the
          // page eagerly also avoids a "Note not found" flash on the note we're deleting.
          const wasActive = pathname === `/notes/${note.id}`;
          setDeleteOpen(false);
          deleteNote.mutate(note.id);
          if (wasActive) router.push('/notes');
        }}
      />
    </>
  );
}

function FavoriteNoteRow({ note, isActive }: { note: Note; isActive: boolean }) {
  const { t } = useTranslation();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        size="sm"
        className="text-sm text-sidebar-foreground"
        isActive={isActive}
      >
        <Link href={`/notes/${note.id}`} aria-label={note.title}>
          <NoteLeadingIcon icon={note.emoji} />
          <span>{note.title}</span>
        </Link>
      </SidebarMenuButton>
      <NoteRowActions
        note={note}
        trigger={
          <SidebarMenuAction showOnHover>
            <EllipsisVertical />
            <span className="sr-only">{t('navigation.collections.more')}</span>
          </SidebarMenuAction>
        }
      />
    </SidebarMenuItem>
  );
}

export function NavNotesGroups() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useNavigation();
  const searchParams = useSearchParams();

  const [favoritesOpen, setFavoritesOpen] = React.useState(true);
  const [foldersOpen, setFoldersOpen] = React.useState(true);
  // How many root folders are on screen. Grows by a page at a time and resets
  // when the group is collapsed - see useShowMore.
  const { shown: shownFolders, showMore: showMoreFolders } = useShowMore(
    foldersOpen,
    RECENT_FOLDER_LIMIT,
    FOLDER_PAGE
  );

  const foldersQ = useFolders();
  const notesQ = useNotes();
  const tagsQ = useTags();
  const noteTagsQ = useAllNoteTags();
  // Memoized because the folder tree derives from them: `?? []` mints a new array every render,
  // which would rebuild the tree (and every row's identity) on any unrelated re-render.
  const folders = React.useMemo(() => foldersQ.data ?? [], [foldersQ.data]);
  const notes = React.useMemo(() => notesQ.data ?? [], [notesQ.data]);
  const tags = tagsQ.data ?? [];
  const tagNames = React.useMemo(() => (tagsQ.data ?? []).map(tag => tag.name), [tagsQ.data]);
  const noteTags = noteTagsQ.data ?? [];
  // First load only (isLoading = fetching with no cached data yet): the groups render
  // skeleton rows instead of conflating "not loaded" with "empty" — "No favorites" used
  // to flash at every boot before the first fetch landed.
  // Favorites derive from all three sources; Folders only needs folders+notes.
  const favoritesLoading = foldersQ.isLoading || notesQ.isLoading || tagsQ.isLoading;
  const foldersLoading = foldersQ.isLoading || notesQ.isLoading;
  // A failed pull is neither loaded nor loading: `listResult` reports isLoading false with data
  // undefined, so an errored folders query would otherwise read as "no folders" and invite creating
  // one on top of a list we simply failed to fetch. Stay silent, as this group did before the row
  // existed. Only the folders query is authoritative here — notes just fill the sub-rows.
  const foldersFailed = Boolean(foldersQ.error);

  const countByTag = new Map<string, number>();
  for (const { tagId } of noteTags) countByTag.set(tagId, (countByTag.get(tagId) ?? 0) + 1);

  const favoriteEntries: FavoriteEntry[] = [
    ...notes
      .filter(n => n.starred)
      .map(note => ({ kind: 'note' as const, createdAt: new Date(note.updatedAt), note })),
    ...folders
      .filter(f => f.favorite)
      .map(folder => ({ kind: 'folder' as const, createdAt: new Date(folder.createdAt), folder })),
    ...tags
      .filter(t => t.favorite)
      .map(tag => ({ kind: 'tag' as const, createdAt: new Date(tag.createdAt), tag })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // The newest few TOP-LEVEL folders, each nesting whatever is inside it. Newest rather than all,
  // matching the tags group: a workspace with forty folders made the sidebar unscrollable. There is
  // no index page behind this any more, so "Show more" beneath the list is the whole route to the
  // rest. Favorites is how an older folder gets pinned up here — it has its own group above.
  //
  // Newest FIRST, not name-sorted, so the rule the list follows is visible; alphabetical order
  // would leave "why these five?" unanswerable.
  const activeFolderId = pathname === '/notes' ? searchParams.get('folder') : null;
  const openNoteFolderId = notes.find(note => pathname === `/notes/${note.id}`)?.folderId ?? null;
  const tree = React.useMemo(() => {
    const direct = new Map<string, number>();
    for (const note of notes) {
      if (note.folderId) direct.set(note.folderId, (direct.get(note.folderId) ?? 0) + 1);
    }
    return buildFolderTree(folders, id => direct.get(id) ?? 0);
  }, [folders, notes]);
  const folderEntries = newestFirst(
    tree.map(node => ({ ...node, id: node.folder.id, createdAt: node.folder.createdAt })),
    shownFolders
  );
  const moreFolders = tree.length > folderEntries.length;

  const [expandedFolders, setExpandedFolders] = React.useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  // The folder menus' dialogs, owned once for the whole group. A folder created inside another
  // opens its parent, or the new row is filed out of sight and the create looks like it did
  // nothing.
  const folderActions = useFolderActions({
    onCreated: parentId => {
      if (parentId) setExpandedFolders(current => new Set([...current, parentId]));
    },
  });
  const parentOf = React.useMemo(() => {
    const map = new Map<string, string>();
    const walk = (node: FolderNode) => {
      for (const child of node.children) {
        map.set(child.folder.id, node.folder.id);
        walk(child);
      }
    };
    for (const node of tree) walk(node);
    return map;
  }, [tree]);
  // Open the path down to wherever the user is, so a nested active folder is not hidden inside a
  // collapsed ancestor. Once per destination: the tree's identity changes on any note edit, and
  // re-running there would re-open a branch the user had just collapsed. But the tree is still a
  // dependency, because on a fresh load straight into a nested folder the folders arrive after
  // the first render, and an effect that had already run against an empty tree never came back.
  const hereFolderId = activeFolderId ?? openNoteFolderId;
  const openedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!hereFolderId || openedFor.current === hereFolderId) return;
    if (!folders.some(folder => folder.id === hereFolderId)) return; // not known yet
    openedFor.current = hereFolderId;
    setExpandedFolders(current => {
      const next = new Set(current);
      let cursor = parentOf.get(hereFolderId);
      while (cursor && !next.has(cursor)) {
        next.add(cursor);
        cursor = parentOf.get(cursor);
      }
      return next.size === current.size ? current : next;
    });
  }, [hereFolderId, folders, parentOf]);
  const toggleFolder = (id: string) =>
    setExpandedFolders(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const isNoteActive = (noteId: string) => pathname === `/notes/${noteId}`;
  const isFolderActive = (folderId: string) =>
    pathname === '/notes' && searchParams.get('folder') === folderId;

  /**
   * A folder and whatever is inside it. Recursive rather than the flat list this used to be: a
   * subfolder rendered beside its parent claims to be its sibling.
   *
   * The disclosure reveals SUBFOLDERS, and the name narrows the note list — the same pair as a tag
   * row, and the same as the folders index. Notes no longer hang under a folder here: a rail that
   * expands into notes AND nests folders is an unbounded tree, which is what made this list
   * unscrollable. Favorites pins the notes worth one click; the rest are one narrow away.
   */
  const renderFolder = (node: FolderNode, depth: number): React.ReactNode => {
    const { folder, children } = node;
    const open = expandedFolders.has(folder.id);
    // Indentation stops growing part-way down, so a deep branch cannot push names off the rail.
    const indent = Math.min(depth, MAX_FOLDER_INDENT);
    return (
      <React.Fragment key={`folder-${folder.id}`}>
        <SidebarMenuItem className="group/folder-row group/folder-item">
          <SidebarMenuButton
            asChild
            size="sm"
            isActive={isFolderActive(folder.id)}
            // No right padding reserved: one hover action is left, and it draws
            // over the row's tail like every other row's does.
            className="text-sm text-sidebar-foreground"
            // 2rem, not 1.75: lands the name 8px after the icon, the gap every other row has.
            style={{ paddingInlineStart: `calc(2rem + 0.6rem * ${indent})` }}
          >
            <Link href={`/notes?folder=${folder.id}`}>
              <span className="truncate">{folder.name}</span>
              {isFolderShared(folders, folder.id) ? (
                <span className="sr-only">{t('folders.shared')}</span>
              ) : null}
            </Link>
          </SidebarMenuButton>
          {/* Over the row rather than inside it: the row is a link, and a button nested in an
              anchor is invalid markup — the click would both toggle and navigate. */}
          <FolderDisclosure
            hasChildren={children.length > 0}
            open={open}
            name={folder.name}
            shared={isFolderShared(folders, folder.id)}
            onToggle={() => toggleFolder(folder.id)}
            className="absolute top-1/2 z-10 -translate-y-1/2 text-sidebar-foreground-muted"
            // Lands the icon on the same left edge as the main nav's icons.
            style={{ insetInlineStart: `calc(0.225rem + 0.6rem * ${indent})` }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuAction showOnHover>
                <EllipsisVertical />
                <span className="sr-only">{t('navigation.collections.folderOptions')}</span>
              </SidebarMenuAction>
            </DropdownMenuTrigger>
            {/* Sized to its longest label - see the note on the tag row's menu. */}
            <DropdownMenuContent
              className="w-max max-w-72 min-w-48 rounded-lg"
              side="right"
              align="start"
            >
              <FolderMenuItems
                folder={folder}
                tree={tree}
                actions={folderActions}
                kit={dropdownMenuKit}
                withFavorite
                onDelete={() => {
                  if (isFolderActive(folder.id)) {
                    router.replace(withoutNotesFilter(searchParams, 'folder', folder.id));
                  }
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
        {open ? children.map(child => renderFolder(child, depth + 1)) : null}
      </React.Fragment>
    );
  };

  return (
    <>
      {/* ── Favorites ── */}
      <Collapsible
        open={favoritesOpen}
        onOpenChange={setFavoritesOpen}
        className="group/favorites-collapsible"
      >
        <SidebarGroup
          data-onboarding="sidebar-favorites"
          className="pb-0 group-data-[collapsible=icon]:hidden"
        >
          <SidebarGroupLabel
            asChild
            className="cursor-pointer gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <CollapsibleTrigger>
              <span>{t('navigation.collections.favorites')}</span>
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/favorites-collapsible:rotate-90" />
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          <CollapsibleContent>
            <SidebarMenu>
              {favoritesLoading ? (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                </>
              ) : favoriteEntries.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled size="sm" className="text-sidebar-foreground-muted">
                    <Star className="size-4" />
                    <span>{t('navigation.collections.noFavorites')}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : (
                favoriteEntries.map(entry =>
                  entry.kind === 'note' ? (
                    <FavoriteNoteRow
                      key={`favorite-note-${entry.note.id}`}
                      note={entry.note}
                      isActive={isNoteActive(entry.note.id)}
                    />
                  ) : entry.kind === 'folder' ? (
                    <SidebarMenuItem key={`favorite-folder-${entry.folder.id}`}>
                      <SidebarMenuButton
                        asChild
                        size="sm"
                        className="text-sm text-sidebar-foreground"
                        isActive={isFolderActive(entry.folder.id)}
                      >
                        <Link
                          href={`/notes?folder=${entry.folder.id}`}
                          aria-label={entry.folder.name}
                        >
                          <FolderIcon className="size-4" />
                          <span>{entry.folder.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : (
                    <TagSidebarRow
                      key={`favorite-tag-${entry.tag.id}`}
                      tag={entry.tag}
                      tagNames={tagNames}
                      noteCount={countByTag.get(entry.tag.id) ?? 0}
                    />
                  )
                )
              )}
            </SidebarMenu>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>

      {/* ── Folders ── */}
      <Collapsible
        open={foldersOpen}
        onOpenChange={setFoldersOpen}
        className="group/folders-collapsible"
      >
        <SidebarGroup
          data-onboarding="sidebar-folders"
          className="group/folders pb-0 pt-0 group-data-[collapsible=icon]:hidden"
        >
          <SidebarGroupLabel
            asChild
            className="cursor-pointer gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <CollapsibleTrigger>
              <span>{t('navigation.collections.folders')}</span>
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/folders-collapsible:rotate-90" />
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          <CollapsibleContent>
            <SidebarMenu>
              {foldersLoading ? (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                </>
              ) : foldersFailed ? null : folderEntries.length === 0 ? (
                // Loaded and empty: this row is the only folder-creating affordance left in the
                // sidebar, the group's "+" having come out with the subfolder work. Without it the
                // section is a label over nothing.
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    className="text-sidebar-foreground-muted"
                    onClick={() => folderActions.createIn(null)}
                  >
                    <Plus className="size-4" />
                    <span>{t('navigation.collections.createFolder')}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              {folderEntries.map(node => renderFolder(node, 0))}
              {/* Under the list, not in the header, and always visible while it
                  has anything to reveal. It used to hide until the section was
                  hovered - unfindable, and the only route to the rest of the
                  list now that the index pages are gone. */}
              {moreFolders ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    className="text-sidebar-foreground-muted"
                    onClick={showMoreFolders}
                  >
                    <span>{t('navigation.collections.showMore')}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>

      <NavTagsGroup />

      {folderActions.dialogs}
    </>
  );
}
