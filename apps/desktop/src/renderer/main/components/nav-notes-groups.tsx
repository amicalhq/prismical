import * as React from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import {
  ChevronRight,
  FileText,
  Folder,
  MoreHorizontal,
  Plus,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import type { Folder as FolderRecord } from "@/db/schema";
import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { toast } from "sonner";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useLocalStorageBoolean } from "@/hooks/useLocalStorageBoolean";
import { api } from "@/trpc/react";
import { FolderEditDialog } from "./folder/folder-edit-dialog";
import { FolderPicker } from "./folder/folder-picker";
import { FolderRowMenu } from "./folder/folder-row-menu";
import { NavTagsGroup } from "./nav-tags-group";
import { TagSidebarRow } from "./tag/tag-sidebar-row";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type NoteNavigationItem = {
  id: number;
  title: string;
  icon: string | null;
  starred: boolean;
  folderId: number | null;
  createdAt: Date;
};

function NoteLeadingIcon({ icon }: { icon: string | null }) {
  if (icon) {
    return <span className="text-base leading-none">{icon}</span>;
  }
  return <FileText className="size-4" />;
}

function NoteDropdownContent({
  note,
  isMobile,
  t,
  onStarredChange,
  onMoveTo,
  onDelete,
}: {
  note: NoteNavigationItem;
  isMobile: boolean;
  t: (key: string) => string;
  onStarredChange: (starred: boolean) => void;
  onMoveTo: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenuContent
      className="w-56 rounded-lg"
      side={isMobile ? "bottom" : "right"}
      align={isMobile ? "end" : "start"}
    >
      {note.starred ? (
        <DropdownMenuItem onSelect={() => onStarredChange(false)}>
          <StarOff />
          <span>{t("settings.notes.note.actions.removeFromFavorites")}</span>
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => onStarredChange(true)}>
          <Star />
          <span>{t("settings.notes.note.actions.addToFavorites")}</span>
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={onMoveTo}>
        <Folder className="h-4 w-4" />
        <span>{t("settings.notes.note.actions.moveToFolder")}</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 />
        <span>{t("settings.notes.note.actions.delete")}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

type RowCommon = {
  note: NoteNavigationItem;
  isActive: boolean;
  isMobile: boolean;
  t: (key: string) => string;
  onStarredChange: (starred: boolean) => void;
  onMoveTo: (noteId: number, anchor: HTMLElement) => void;
  onDelete: () => void;
};

function FavoriteNoteRow({
  note,
  isActive,
  isMobile,
  t,
  onStarredChange,
  onMoveTo,
  onDelete,
}: RowCommon) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive}>
        <Link
          to="/notes/$noteId"
          params={{ noteId: String(note.id) }}
          search={{}}
          aria-label={note.title}
        >
          <NoteLeadingIcon icon={note.icon} />
          <span>{note.title}</span>
        </Link>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction ref={triggerRef} showOnHover>
            <MoreHorizontal />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <NoteDropdownContent
          note={note}
          isMobile={isMobile}
          t={t}
          onStarredChange={onStarredChange}
          onMoveTo={() => {
            if (triggerRef.current) onMoveTo(note.id, triggerRef.current);
          }}
          onDelete={onDelete}
        />
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function NoteSubRow({
  note,
  isActive,
  isMobile,
  t,
  onStarredChange,
  onMoveTo,
  onDelete,
}: RowCommon) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  return (
    <SidebarMenuSubItem className="group/sub-item relative">
      <SidebarMenuSubButton asChild isActive={isActive} className="pr-6">
        <Link
          to="/notes/$noteId"
          params={{ noteId: String(note.id) }}
          search={{}}
          aria-label={note.title}
        >
          <NoteLeadingIcon icon={note.icon} />
          <span>{note.title}</span>
        </Link>
      </SidebarMenuSubButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-sidebar-foreground/70 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/sub-item:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
            <span className="sr-only">More</span>
          </button>
        </DropdownMenuTrigger>
        <NoteDropdownContent
          note={note}
          isMobile={isMobile}
          t={t}
          onStarredChange={onStarredChange}
          onMoveTo={() => {
            if (triggerRef.current) onMoveTo(note.id, triggerRef.current);
          }}
          onDelete={onDelete}
        />
      </DropdownMenu>
    </SidebarMenuSubItem>
  );
}

export function NavNotesGroups({ notes }: { notes: NoteNavigationItem[] }) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const utils = api.useUtils();

  const deleteMutation = api.notes.deleteNote.useMutation({
    onSuccess: (_data, variables) => {
      utils.notes.getNotes.invalidate();
      if (location.pathname === `/notes/${variables.id}`) {
        navigate({ to: "/notes" });
      }
      toast.success(t("settings.notes.toast.deleted"));
    },
    onError: (error) => {
      toast.error(
        t("settings.notes.toast.deleteFailed", { message: error.message }),
      );
    },
  });

  const updateOrganization = api.notes.updateNoteOrganization.useMutation({
    onSuccess: () => {
      utils.notes.getNotes.invalidate();
    },
  });

  const createNoteMutation = api.notes.createNote.useMutation({
    onSuccess: async (newNote) => {
      utils.notes.getNotes.invalidate();
      navigate({
        to: "/notes/$noteId",
        params: { noteId: String(newNote.id) },
        search: {},
      });
    },
    onError: (error) => {
      toast.error(
        t("settings.notes.toast.createFailed", { message: error.message }),
      );
    },
  });

  const handleCreateNoteInFolder = useCallback(
    (folderId: number) => {
      if (createNoteMutation.isPending) return;
      const dateStr = new Date().toLocaleDateString(i18n.language, {
        day: "numeric",
        month: "short",
      });
      createNoteMutation.mutate(
        { title: t("settings.notes.defaultTitleWithDate", { date: dateStr }) },
        {
          onSuccess: (newNote) => {
            updateOrganization.mutate({ id: newNote.id, folderId });
          },
        },
      );
    },
    [createNoteMutation, i18n.language, t, updateOrganization],
  );

  const handleDelete = (noteId: number) => {
    deleteMutation.mutate({ id: noteId });
  };

  const handleFolderChange = (noteId: number, folderId: number | null) => {
    updateOrganization.mutate({ id: noteId, folderId });
  };

  const [folderPickerForNoteId, setFolderPickerForNoteId] = React.useState<
    number | null
  >(null);
  const folderPickerAnchorRef = React.useRef<HTMLElement | null>(null);

  const handleRequestMove = React.useCallback(
    (noteId: number, anchor: HTMLElement) => {
      folderPickerAnchorRef.current = anchor;
      setFolderPickerForNoteId(noteId);
    },
    [],
  );

  const [editingFolder, setEditingFolder] =
    React.useState<FolderRecord | null>(null);
  const [deletingFolder, setDeletingFolder] =
    React.useState<FolderRecord | null>(null);

  const deleteFolderMutation = api.folders.delete.useMutation({
    onSuccess: (result) => {
      // Cascade wipes notes, which transitively wipes their tags / artifacts
      // / meetings via FK. Invalidate every namespace whose cache could now
      // contain rows that point at deleted notes.
      utils.folders.invalidate();
      utils.notes.invalidate();
      utils.tags.invalidate();
      utils.artifacts.invalidate();
      utils.meetings.invalidate();
      setDeletingFolder(null);
      toast.success(
        t("settings.notes.toast.folderDeleted", {
          noteCount: result.deletedNoteCount,
          folderCount: result.deletedSubfolderCount,
        }),
      );
    },
    onError: (error) => {
      toast.error(
        t("settings.folders.errors.deleteFailed", { message: error.message }),
      );
    },
  });

  const deletePreviewQ = api.folders.getDeletePreview.useQuery(
    { id: deletingFolder?.id ?? 0 },
    {
      enabled: deletingFolder !== null,
      // The dialog drives a destructive action — never serve a stale count.
      staleTime: 0,
      gcTime: 0,
    },
  );

  const favoriteNotes = React.useMemo(
    () => notes.filter((note) => note.starred),
    [notes],
  );

  const favoriteTagsQ = api.tags.listFavorites.useQuery();
  const favoriteFoldersQ = api.folders.listFavorites.useQuery();
  const tagCountsQ = api.tags.listWithCounts.useQuery({ sortBy: "createdAt" });

  const tagNoteCountFor = React.useCallback(
    (tagId: number) =>
      tagCountsQ.data?.find((c) => c.id === tagId)?.noteCount ?? 0,
    [tagCountsQ.data],
  );

  type FavoriteEntry =
    | { kind: "note"; createdAt: Date; note: NoteNavigationItem }
    | { kind: "tag"; createdAt: Date; tag: NonNullable<typeof favoriteTagsQ.data>[number] }
    | { kind: "folder"; createdAt: Date; folder: NonNullable<typeof favoriteFoldersQ.data>[number] };

  const favoriteEntries = React.useMemo<FavoriteEntry[]>(() => {
    const entries: FavoriteEntry[] = [
      ...favoriteNotes.map<FavoriteEntry>((note) => ({
        kind: "note",
        createdAt: new Date(note.createdAt),
        note,
      })),
      ...(favoriteTagsQ.data ?? []).map<FavoriteEntry>((tag) => ({
        kind: "tag",
        createdAt: new Date(tag.createdAt),
        tag,
      })),
      ...(favoriteFoldersQ.data ?? []).map<FavoriteEntry>((folder) => ({
        kind: "folder",
        createdAt: new Date(folder.createdAt),
        folder,
      })),
    ];
    entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return entries;
  }, [favoriteNotes, favoriteTagsQ.data, favoriteFoldersQ.data]);

  const foldersQ = api.folders.list.useQuery({ sortBy: "name" });
  const allFolders = foldersQ.data ?? [];

  const notesByFolderId = React.useMemo(() => {
    const grouped = new Map<number, NoteNavigationItem[]>();
    for (const note of notes) {
      if (note.folderId === null) continue;
      const existing = grouped.get(note.folderId) ?? [];
      existing.push(note);
      grouped.set(note.folderId, existing);
    }
    return grouped;
  }, [notes]);

  const folderEntries = React.useMemo(
    () =>
      allFolders.map((f) => ({
        folder: f,
        notes: notesByFolderId.get(f.id) ?? [],
      })),
    [allFolders, notesByFolderId],
  );

  const isNoteActive = (noteId: number) =>
    location.pathname === `/notes/${noteId}`;

  const search = useSearch({ strict: false }) as { folder?: number };
  const isFolderActive = (folderId: number) =>
    location.pathname === "/notes" && search.folder === folderId;

  const [favoritesOpen, setFavoritesOpen] = useLocalStorageBoolean(
    "sidebar:favorites:open",
    true,
  );
  const [foldersOpen, setFoldersOpen] = useLocalStorageBoolean(
    "sidebar:folders:open",
    true,
  );

  return (
    <>
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
              <span>{t("settings.sidebar.favorites")}</span>
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/favorites-collapsible:rotate-90" />
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          <CollapsibleContent>
            <SidebarMenu>
              {favoriteEntries.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    disabled
                    className="text-sidebar-foreground/60"
                  >
                    <Star className="size-4" />
                    <span>{t("settings.sidebar.noFavorites")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : (
                favoriteEntries.map((entry) =>
                  entry.kind === "note" ? (
                    <FavoriteNoteRow
                      key={`favorite-note-${entry.note.id}`}
                      note={entry.note}
                      isActive={isNoteActive(entry.note.id)}
                      isMobile={isMobile}
                      t={t}
                      onStarredChange={(starred) =>
                        updateOrganization.mutate({
                          id: entry.note.id,
                          starred,
                        })
                      }
                      onMoveTo={handleRequestMove}
                      onDelete={() => handleDelete(entry.note.id)}
                    />
                  ) : entry.kind === "folder" ? (
                    <SidebarMenuItem key={`favorite-folder-${entry.folder.id}`}>
                      <SidebarMenuButton
                        asChild
                        isActive={isFolderActive(entry.folder.id)}
                      >
                        <Link
                          to="/notes"
                          search={{ folder: entry.folder.id }}
                          aria-label={entry.folder.name}
                        >
                          <Folder className="size-4" />
                          <span>{entry.folder.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : (
                    <TagSidebarRow
                      key={`favorite-tag-${entry.tag.id}`}
                      tag={entry.tag}
                      noteCount={tagNoteCountFor(entry.tag.id)}
                    />
                  ),
                )
              )}
            </SidebarMenu>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>

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
              <span>{t("settings.sidebar.folders")}</span>
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/folders-collapsible:rotate-90" />
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          <SidebarGroupAction
            asChild
            className="top-1.5 right-2 aspect-auto h-5 w-auto px-1.5 text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground opacity-0 transition-opacity after:hidden focus-visible:opacity-100 group-hover/folders:opacity-100"
          >
            <Link
              to="/notes"
              search={{}}
              aria-label={t("settings.sidebar.viewAllFolders")}
            >
              {t("settings.sidebar.viewAllFolders")} ›
            </Link>
          </SidebarGroupAction>
          <CollapsibleContent>
            <SidebarMenu>
              {folderEntries.map(({ folder, notes: folderNotes }) => (
                <Collapsible
                  key={`folder-${folder.id}`}
                  defaultOpen={folderNotes.some((note) => isNoteActive(note.id))}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton>
                        <ChevronRight className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                        <span>{folder.name}</span>
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <FolderRowMenu
                      folder={folder}
                      onRename={() => setEditingFolder(folder)}
                      onDelete={() => setDeletingFolder(folder)}
                    />
                    <SidebarMenuAction
                      showOnHover
                      onClick={() => handleCreateNoteInFolder(folder.id)}
                      className="right-7"
                    >
                      <Plus />
                      <span className="sr-only">
                        {t("settings.notes.create")}
                      </span>
                    </SidebarMenuAction>
                    <CollapsibleContent>
                      <SidebarMenuSub className="mr-0 pr-0">
                        {folderNotes.length === 0 ? (
                          <SidebarMenuSubItem>
                            <div className="flex h-7 items-center px-2 text-xs italic text-sidebar-foreground/60">
                              {t("settings.sidebar.folderEmpty")}
                            </div>
                          </SidebarMenuSubItem>
                        ) : (
                          folderNotes.map((note) => (
                            <NoteSubRow
                              key={`folder-${folder.id}-${note.id}`}
                              note={note}
                              isActive={isNoteActive(note.id)}
                              isMobile={isMobile}
                              t={t}
                              onStarredChange={(starred) =>
                                updateOrganization.mutate({
                                  id: note.id,
                                  starred,
                                })
                              }
                              onMoveTo={handleRequestMove}
                              onDelete={() => handleDelete(note.id)}
                            />
                          ))
                        )}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              ))}
              {folderEntries.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    disabled
                    className="text-sidebar-foreground/60"
                  >
                    <Folder className="size-4" />
                    <span>{t("settings.sidebar.noFolders")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>

      <NavTagsGroup />

      <FolderPicker
        open={folderPickerForNoteId !== null}
        onOpenChange={(open) => {
          if (!open) setFolderPickerForNoteId(null);
        }}
        currentFolderId={
          notes.find((n) => n.id === folderPickerForNoteId)?.folderId ?? null
        }
        onSelect={(folderId) => {
          if (folderPickerForNoteId !== null) {
            handleFolderChange(folderPickerForNoteId, folderId);
          }
        }}
        anchor={folderPickerAnchorRef}
      />

      <FolderEditDialog
        folder={editingFolder}
        open={editingFolder !== null}
        onOpenChange={(open) => {
          if (!open) setEditingFolder(null);
        }}
      />

      <AlertDialog
        open={deletingFolder !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingFolder(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.notes.folder.delete.title", {
                name: deletingFolder?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.notes.folder.delete.description", {
                noteCount: deletePreviewQ.data?.noteCount ?? 0,
                folderCount: deletePreviewQ.data?.subfolderCount ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.tags.editDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!deletePreviewQ.isSuccess}
              onClick={() => {
                if (deletingFolder) {
                  deleteFolderMutation.mutate({ id: deletingFolder.id });
                }
              }}
            >
              {t("settings.notes.folder.delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
