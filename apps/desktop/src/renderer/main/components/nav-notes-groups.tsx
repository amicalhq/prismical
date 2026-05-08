import * as React from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
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
import { CreateFolderDialog } from "./create-folder-dialog";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { NavTagsGroup } from "./nav-tags-group";
import { TagSidebarRow } from "./tag/tag-sidebar-row";

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
        <FolderOpen className="h-4 w-4" />
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
    onSuccess: async (newNote, _variables, context) => {
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

  const [createFolderForNoteId, setCreateFolderForNoteId] = React.useState<
    number | null
  >(null);

  const [folderPickerForNoteId, setFolderPickerForNoteId] = React.useState<
    number | null
  >(null);

  const handleCreateFolder = (noteId: number) => {
    setCreateFolderForNoteId(noteId);
  };

  const favoriteNotes = React.useMemo(
    () => notes.filter((note) => note.starred),
    [notes],
  );

  const favoriteTagsQ = api.tags.listFavorites.useQuery();
  const tagCountsQ = api.tags.listWithCounts.useQuery({ sortBy: "createdAt" });

  const tagNoteCountFor = React.useCallback(
    (tagId: number) =>
      tagCountsQ.data?.find((c) => c.id === tagId)?.noteCount ?? 0,
    [tagCountsQ.data],
  );

  type FavoriteEntry =
    | { kind: "note"; createdAt: Date; note: NoteNavigationItem }
    | { kind: "tag"; createdAt: Date; tag: NonNullable<typeof favoriteTagsQ.data>[number] };

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
    ];
    entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return entries;
  }, [favoriteNotes, favoriteTagsQ.data]);

  const folders = React.useMemo(() => {
    const grouped = new Map<number, NoteNavigationItem[]>();

    for (const note of notes) {
      if (note.folderId == null) continue;
      const existing = grouped.get(note.folderId) ?? [];
      existing.push(note);
      grouped.set(note.folderId, existing);
    }

    return Array.from(grouped.entries()).sort(([a], [b]) => a - b);
  }, [notes]);

  const folderIds = React.useMemo(
    () => folders.map(([id]) => id),
    [folders],
  );

  const isNoteActive = (noteId: number) =>
    location.pathname === `/notes/${noteId}`;

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
                    <SidebarMenuItem key={`favorite-note-${entry.note.id}`}>
                      <SidebarMenuButton
                        asChild
                        isActive={isNoteActive(entry.note.id)}
                      >
                        <Link
                          to="/notes/$noteId"
                          params={{ noteId: String(entry.note.id) }}
                          search={{}}
                          aria-label={entry.note.title}
                        >
                          <NoteLeadingIcon icon={entry.note.icon} />
                          <span>{entry.note.title}</span>
                        </Link>
                      </SidebarMenuButton>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <SidebarMenuAction showOnHover>
                            <MoreHorizontal />
                            <span className="sr-only">More</span>
                          </SidebarMenuAction>
                        </DropdownMenuTrigger>
                        <NoteDropdownContent
                          note={entry.note}
                          isMobile={isMobile}
                          t={t}
                          onStarredChange={(starred) =>
                            updateOrganization.mutate({
                              id: entry.note.id,
                              starred,
                            })
                          }
                          onMoveTo={() =>
                            setFolderPickerForNoteId(entry.note.id)
                          }
                          onDelete={() => handleDelete(entry.note.id)}
                        />
                      </DropdownMenu>
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
        <SidebarGroup className="pb-0 pt-0 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel
            asChild
            className="cursor-pointer gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <CollapsibleTrigger>
              <span>{t("settings.sidebar.folders")}</span>
              <ChevronRight className="size-3 transition-transform group-data-[state=open]/folders-collapsible:rotate-90" />
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          <CollapsibleContent>
            <SidebarMenu>
              {folders.map(([folderId, folderNotes]) => (
                <Collapsible
                  key={folderId}
                  defaultOpen={folderNotes.some((note) => isNoteActive(note.id))}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton>
                        <ChevronRight className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                        <span>{String(folderId)}</span>
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <SidebarMenuAction
                      showOnHover
                      onClick={() => handleCreateNoteInFolder(folderId)}
                    >
                      <Plus />
                      <span className="sr-only">
                        {t("settings.notes.create")}
                      </span>
                    </SidebarMenuAction>
                    <CollapsibleContent>
                      <SidebarMenuSub className="mr-0 pr-0">
                        {folderNotes.map((note) => (
                          <SidebarMenuSubItem
                            key={`folder-${folderId}-${note.id}`}
                            className="group/sub-item relative"
                          >
                            <SidebarMenuSubButton
                              asChild
                              isActive={isNoteActive(note.id)}
                              className="pr-6"
                            >
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
                                onStarredChange={(starred) =>
                                  updateOrganization.mutate({
                                    id: note.id,
                                    starred,
                                  })
                                }
                                onMoveTo={() =>
                                  setFolderPickerForNoteId(note.id)
                                }
                                onDelete={() => handleDelete(note.id)}
                              />
                            </DropdownMenu>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              ))}
              {folders.length === 0 ? (
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

      <FolderPickerDialog
        open={folderPickerForNoteId !== null}
        onOpenChange={(open) => {
          if (!open) setFolderPickerForNoteId(null);
        }}
        currentFolderId={
          notes.find((n) => n.id === folderPickerForNoteId)?.folderId ?? null
        }
        folderIds={folderIds}
        onSelect={(folderId) => {
          if (folderPickerForNoteId !== null) {
            handleFolderChange(folderPickerForNoteId, folderId);
          }
        }}
        onCreateFolder={() => {
          if (folderPickerForNoteId !== null) {
            handleCreateFolder(folderPickerForNoteId);
          }
        }}
      />

      <CreateFolderDialog
        open={createFolderForNoteId !== null}
        onOpenChange={(open) => {
          if (!open) setCreateFolderForNoteId(null);
        }}
        onCreated={(folderId) => {
          if (createFolderForNoteId !== null) {
            updateOrganization.mutate({
              id: createFolderForNoteId,
              folderId,
            });
          }
        }}
      />
    </>
  );
}
