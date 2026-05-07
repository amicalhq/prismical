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
import { api } from "@/trpc/react";
import { CreateFolderDialog } from "./create-folder-dialog";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { NavTagsGroup } from "./nav-tags-group";
import { TagHash } from "./tag/tag-hash";

type NoteNavigationItem = {
  id: number;
  title: string;
  icon: string | null;
  starred: boolean;
  folder: string | null;
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
      if (location.pathname === `/settings/notes/${variables.id}`) {
        navigate({ to: "/settings/notes" });
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
        to: "/settings/notes/$noteId",
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
    (folderName: string) => {
      if (createNoteMutation.isPending) return;
      const dateStr = new Date().toLocaleDateString(i18n.language, {
        day: "numeric",
        month: "short",
      });
      createNoteMutation.mutate(
        { title: t("settings.notes.defaultTitleWithDate", { date: dateStr }) },
        {
          onSuccess: (newNote) => {
            updateOrganization.mutate({ id: newNote.id, folder: folderName });
          },
        },
      );
    },
    [createNoteMutation, i18n.language, t, updateOrganization],
  );

  const handleDelete = (noteId: number) => {
    deleteMutation.mutate({ id: noteId });
  };

  const handleFolderChange = (noteId: number, folder: string | null) => {
    updateOrganization.mutate({ id: noteId, folder });
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

  const favorites = React.useMemo(
    () => notes.filter((note) => note.starred),
    [notes],
  );

  const favoriteTagsQ = api.tags.listFavorites.useQuery();

  const folders = React.useMemo(() => {
    const grouped = new Map<string, NoteNavigationItem[]>();

    for (const note of notes) {
      const name = note.folder?.trim();
      if (!name) continue;
      const existing = grouped.get(name) ?? [];
      existing.push(note);
      grouped.set(name, existing);
    }

    return Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [notes]);

  const folderNames = React.useMemo(
    () => folders.map(([name]) => name),
    [folders],
  );

  const isNoteActive = (noteId: number) =>
    location.pathname === `/settings/notes/${noteId}`;

  return (
    <>
      <SidebarGroup className="pb-0 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>{t("settings.sidebar.favorites")}</SidebarGroupLabel>
        <SidebarMenu>
          {favorites.map((note) => (
            <SidebarMenuItem key={`favorite-${note.id}`}>
              <SidebarMenuButton asChild isActive={isNoteActive(note.id)}>
                <Link
                  to="/settings/notes/$noteId"
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
                  <SidebarMenuAction showOnHover>
                    <MoreHorizontal />
                    <span className="sr-only">More</span>
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <NoteDropdownContent
                  note={note}
                  isMobile={isMobile}
                  t={t}
                  onStarredChange={(starred) =>
                    updateOrganization.mutate({ id: note.id, starred })
                  }
                  onMoveTo={() => setFolderPickerForNoteId(note.id)}
                  onDelete={() => handleDelete(note.id)}
                />
              </DropdownMenu>
            </SidebarMenuItem>
          ))}
          {(favoriteTagsQ.data ?? []).map((tag) => (
            <SidebarMenuItem key={`fav-tag-${tag.id}`}>
              <SidebarMenuButton asChild>
                <Link
                  to={"/settings/notes" as never}
                  search={{ tag: tag.id } as never}
                  aria-label={`#${tag.name}`}
                >
                  <TagHash color={tag.color} name={tag.name} />
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {favorites.length === 0 &&
          (favoriteTagsQ.data?.length ?? 0) === 0 ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled
                className="text-sidebar-foreground/60"
              >
                <Star className="size-4" />
                <span>{t("settings.sidebar.noFavorites")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup className="pt-0 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>{t("settings.sidebar.folders")}</SidebarGroupLabel>
        <SidebarMenu>
          {folders.map(([folderName, folderNotes]) => (
            <Collapsible
              key={folderName}
              defaultOpen={folderNotes.some((note) => isNoteActive(note.id))}
              className="group/collapsible"
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton>
                    <ChevronRight className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    <span>{folderName}</span>
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <SidebarMenuAction
                  showOnHover
                  onClick={() => handleCreateNoteInFolder(folderName)}
                >
                  <Plus />
                  <span className="sr-only">{t("settings.notes.create")}</span>
                </SidebarMenuAction>
                <CollapsibleContent>
                  <SidebarMenuSub className="mr-0 pr-0">
                    {folderNotes.map((note) => (
                      <SidebarMenuSubItem
                        key={`folder-${folderName}-${note.id}`}
                        className="group/sub-item relative"
                      >
                        <SidebarMenuSubButton
                          asChild
                          isActive={isNoteActive(note.id)}
                          className="pr-6"
                        >
                          <Link
                            to="/settings/notes/$noteId"
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
                            onMoveTo={() => setFolderPickerForNoteId(note.id)}
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
      </SidebarGroup>

      <NavTagsGroup />

      <FolderPickerDialog
        open={folderPickerForNoteId !== null}
        onOpenChange={(open) => {
          if (!open) setFolderPickerForNoteId(null);
        }}
        currentFolder={
          notes.find((n) => n.id === folderPickerForNoteId)?.folder ?? null
        }
        folderNames={folderNames}
        onFolderChange={(folder) => {
          if (folderPickerForNoteId !== null) {
            handleFolderChange(folderPickerForNoteId, folder);
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
        onConfirm={(folderName) => {
          if (createFolderForNoteId !== null) {
            updateOrganization.mutate({
              id: createFolderForNoteId,
              folder: folderName,
            });
          }
        }}
      />
    </>
  );
}
