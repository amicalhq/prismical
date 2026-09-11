'use client';

import * as React from 'react';
import { AppLink as Link } from './app-link';
import { usePathname, useNavigation, useSearchParams, useFeatureFlag } from '@prismical/app-client';
import {
  Check,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  UserPlus,
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
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '../ui/sidebar';
import { TagSidebarRow } from './tag-sidebar-row';
import { NavTagsGroup } from './nav-tags-group';
import type { Note, FavoriteEntry } from '@prismical/app-contracts';
import {
  useFolders,
  useCreateFolder,
  useUpdateFolder,
  useDeleteFolder,
} from '@prismical/app-client';
import { useNotes, useCreateNote, useUpdateNote, useDeleteNote } from '@prismical/app-client';
import { useTags } from '@prismical/app-client';
import { useAllNoteTags } from '@prismical/app-client';
import { ShareDialog } from './share-dialog';
import { FolderNameDialog } from './folder-name-dialog';
import { DeleteFolderDialog } from './delete-folder-dialog';
import { DeleteNoteDialog } from './delete-note-dialog';
import { useTranslation } from 'react-i18next';
import { withoutNotesFilter } from '../lib/notes-filter-url';

function NoteLeadingIcon({ icon }: { icon?: string }) {
  if (icon) return <span className="text-base leading-none">{icon}</span>;
  return <FileText className="size-4" />;
}

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
            <MoreHorizontal />
            <span className="sr-only">{t('navigation.collections.more')}</span>
          </SidebarMenuAction>
        }
      />
    </SidebarMenuItem>
  );
}

function NoteSubRow({ note, isActive }: { note: Note; isActive: boolean }) {
  const { t } = useTranslation();
  return (
    <SidebarMenuSubItem className="group/sub-item relative">
      <SidebarMenuSubButton
        asChild
        size="sm"
        isActive={isActive}
        className="pr-6 text-sm text-sidebar-foreground"
      >
        <Link href={`/notes/${note.id}`} aria-label={note.title}>
          <NoteLeadingIcon icon={note.emoji} />
          <span>{note.title}</span>
        </Link>
      </SidebarMenuSubButton>
      <NoteRowActions
        note={note}
        trigger={
          <button
            type="button"
            aria-label={t('navigation.collections.noteOptions', { title: note.title })}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-sidebar-foreground opacity-0 hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/sub-item:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
            <span className="sr-only">{t('navigation.collections.more')}</span>
          </button>
        }
      />
    </SidebarMenuSubItem>
  );
}

export function NavNotesGroups() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useNavigation();
  const searchParams = useSearchParams();
  const createNote = useCreateNote();

  const [favoritesOpen, setFavoritesOpen] = React.useState(true);
  const [foldersOpen, setFoldersOpen] = React.useState(true);
  const [shareFolder, setShareFolder] = React.useState<{ id: string; name: string } | null>(null);
  // Sharing is an org feature (off in the desktop local workspace).
  const { enabled: sharingEnabled } = useFeatureFlag('sharing');
  const [createFolderOpen, setCreateFolderOpen] = React.useState(false);
  const [renameFolder, setRenameFolder] = React.useState<{ id: string; name: string } | null>(null);
  const [deleteFolder, setDeleteFolder] = React.useState<{ id: string; name: string } | null>(null);

  const createFolder = useCreateFolder();
  // Separate mutation instances so a background favorite-toggle can't gate the rename dialog's
  // `pending` (which would swallow its Esc/Cancel and trap it open).
  const favoriteFolder = useUpdateFolder();
  const renameFolderMut = useUpdateFolder();
  const deleteFolderMut = useDeleteFolder();

  const foldersQ = useFolders();
  const notesQ = useNotes();
  const tagsQ = useTags();
  const noteTagsQ = useAllNoteTags();
  const folders = foldersQ.data ?? [];
  const notes = notesQ.data ?? [];
  const tags = tagsQ.data ?? [];
  const tagNames = React.useMemo(() => (tagsQ.data ?? []).map(tag => tag.name), [tagsQ.data]);
  const noteTags = noteTagsQ.data ?? [];
  // First load only (isLoading = fetching with no cached data yet): the groups render
  // skeleton rows instead of conflating "not loaded" with "empty" — "No favorites" used
  // to flash at every boot before the first fetch landed.
  // Favorites derive from all three sources; Folders only needs folders+notes.
  const favoritesLoading = foldersQ.isLoading || notesQ.isLoading || tagsQ.isLoading;
  const foldersLoading = foldersQ.isLoading || notesQ.isLoading;

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

  // All folders, name-sorted — each is its own collapsible row (mirrors the
  // desktop flat folder list, which expands to show that folder's direct notes).
  const folderEntries = [...folders]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(folder => ({ folder, notes: notes.filter(n => n.folderId === folder.id) }));

  const isNoteActive = (noteId: string) => pathname === `/notes/${noteId}`;
  const isFolderActive = (folderId: string) =>
    pathname === '/notes' && searchParams.get('folder') === folderId;

  return (
    <>
      {/* ── Favorites ── */}
      <Collapsible
        open={favoritesOpen}
        onOpenChange={setFavoritesOpen}
        className="group/favorites-collapsible"
      >
        <SidebarGroup className="pb-0 group-data-[collapsible=icon]:hidden">
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
        <SidebarGroup className="group/folders pb-0 pt-0 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel
            asChild
            className="cursor-pointer gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <CollapsibleTrigger>
              <span>{t('navigation.collections.folders')}</span>
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/folders-collapsible:rotate-90" />
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          <SidebarGroupAction
            asChild
            className="top-1.5 right-2 aspect-auto h-5 w-auto px-1.5 text-xs font-medium text-sidebar-foreground-muted hover:text-sidebar-foreground opacity-0 transition-opacity after:hidden focus-visible:opacity-100 group-hover/folders:opacity-100"
          >
            <Link href="/folders" aria-label={t('navigation.collections.viewAllFolders')}>
              {t('navigation.collections.viewAll')}
            </Link>
          </SidebarGroupAction>
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
              ) : null}
              {folderEntries.map(({ folder, notes: folderNotes }) => (
                <Collapsible
                  key={`folder-${folder.id}`}
                  defaultOpen={folderNotes.some(note => isNoteActive(note.id))}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton size="sm" className="text-sm text-sidebar-foreground">
                        <ChevronRight className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                        <span>{folder.name}</span>
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction showOnHover>
                          <MoreHorizontal />
                          <span className="sr-only">
                            {t('navigation.collections.folderOptions')}
                          </span>
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-48 rounded-lg" side="right" align="start">
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
                        {sharingEnabled && (
                          <DropdownMenuItem
                            onSelect={() => setShareFolder({ id: folder.id, name: folder.name })}
                          >
                            <UserPlus className="h-4 w-4" />
                            <span>{t('navigation.collections.shareFolder')}</span>
                          </DropdownMenuItem>
                        )}
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
                    <SidebarMenuAction
                      showOnHover
                      className="right-7"
                      disabled={createNote.isPending}
                      onClick={e => {
                        // The "+" sits over the collapsible row — don't let the
                        // click toggle the folder open/closed.
                        e.preventDefault();
                        e.stopPropagation();
                        createNote.mutate(
                          { folderId: folder.id },
                          { onSuccess: note => router.push(`/notes/${note.id}`) }
                        );
                      }}
                    >
                      <Plus />
                      <span className="sr-only">
                        {t('navigation.collections.newNoteIn', { folder: folder.name })}
                      </span>
                    </SidebarMenuAction>
                    <CollapsibleContent>
                      <SidebarMenuSub className="mr-0 pr-0">
                        {folderNotes.length === 0 ? (
                          <SidebarMenuSubItem>
                            <div className="flex h-7 items-center px-2 text-xs italic text-sidebar-foreground-muted">
                              {t('navigation.collections.noNotes')}
                            </div>
                          </SidebarMenuSubItem>
                        ) : (
                          folderNotes.map(note => (
                            <NoteSubRow
                              key={`folder-${folder.id}-${note.id}`}
                              note={note}
                              isActive={isNoteActive(note.id)}
                            />
                          ))
                        )}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="text-sidebar-foreground-muted hover:text-sidebar-foreground"
                  onClick={() => setCreateFolderOpen(true)}
                >
                  <Plus className="size-4" />
                  <span>{t('navigation.collections.newFolder')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>

      <NavTagsGroup />

      {sharingEnabled && shareFolder && (
        <ShareDialog
          resourceType="folder"
          resourceId={shareFolder.id}
          resourceTitle={shareFolder.name}
          open={!!shareFolder}
          onOpenChange={o => !o && setShareFolder(null)}
        />
      )}

      <FolderNameDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        mode="create"
        pending={createFolder.isPending}
        onSubmit={name =>
          createFolder.mutate(name, { onSuccess: () => setCreateFolderOpen(false) })
        }
      />

      <FolderNameDialog
        open={!!renameFolder}
        onOpenChange={o => !o && setRenameFolder(null)}
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
          if (isFolderActive(deleteFolder.id)) {
            router.replace(withoutNotesFilter(searchParams, 'folder', deleteFolder.id));
          }
          deleteFolderMut.mutate(deleteFolder.id, { onSuccess: () => setDeleteFolder(null) });
        }}
      />
    </>
  );
}
