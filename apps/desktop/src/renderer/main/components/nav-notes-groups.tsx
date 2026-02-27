import * as React from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  folderNames,
  isMobile,
  t,
  onStarredChange,
  onFolderChange,
  onCreateFolder,
  onDelete,
}: {
  note: NoteNavigationItem;
  folderNames: string[];
  isMobile: boolean;
  t: (key: string) => string;
  onStarredChange: (starred: boolean) => void;
  onFolderChange: (folder: string | null) => void;
  onCreateFolder: () => void;
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
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span>{t("settings.notes.note.actions.moveToFolder")}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={() => onFolderChange(null)}>
            <Check
              className={`h-4 w-4 ${note.folder ? "opacity-0" : "opacity-100"}`}
            />
            <span>{t("settings.notes.note.actions.noFolder")}</span>
          </DropdownMenuItem>
          {folderNames.map((name) => (
            <DropdownMenuItem key={name} onSelect={() => onFolderChange(name)}>
              <Check
                className={`h-4 w-4 ${note.folder === name ? "opacity-100" : "opacity-0"}`}
              />
              <span>{name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onCreateFolder}>
            <FolderPlus />
            <span>{t("settings.notes.note.actions.newFolder")}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 />
        <span>{t("settings.notes.note.actions.delete")}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export function NavNotesGroups({ notes }: { notes: NoteNavigationItem[] }) {
  const { t } = useTranslation();
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

  const handleDelete = (noteId: number) => {
    deleteMutation.mutate({ id: noteId });
  };

  const handleFolderChange = (noteId: number, folder: string | null) => {
    updateOrganization.mutate({ id: noteId, folder });
  };

  const handleCreateFolder = (noteId: number) => {
    const nextFolder = window
      .prompt(t("settings.notes.note.actions.newFolderPrompt"))
      ?.trim();
    if (!nextFolder) return;
    updateOrganization.mutate({ id: noteId, folder: nextFolder });
  };

  const favorites = React.useMemo(
    () => notes.filter((note) => note.starred),
    [notes],
  );

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
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
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
                  folderNames={folderNames}
                  isMobile={isMobile}
                  t={t}
                  onStarredChange={(starred) =>
                    updateOrganization.mutate({ id: note.id, starred })
                  }
                  onFolderChange={(folder) =>
                    handleFolderChange(note.id, folder)
                  }
                  onCreateFolder={() => handleCreateFolder(note.id)}
                  onDelete={() => handleDelete(note.id)}
                />
              </DropdownMenu>
            </SidebarMenuItem>
          ))}
          {favorites.length === 0 ? (
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

      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>{t("settings.sidebar.folders")}</SidebarGroupLabel>
        <SidebarMenu>
          {folders.map(([folderName, folderNotes]) => (
            <Collapsible
              key={folderName}
              defaultOpen={folderNotes.some((note) => isNoteActive(note.id))}
            >
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <Folder className="size-4" />
                  <span>{folderName}</span>
                </SidebarMenuButton>
                <CollapsibleTrigger asChild>
                  <SidebarMenuAction
                    className="bg-sidebar-accent text-sidebar-accent-foreground data-[state=open]:rotate-90"
                    showOnHover
                  >
                    <ChevronRight />
                    <span className="sr-only">{folderName}</span>
                  </SidebarMenuAction>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {folderNotes.map((note) => (
                      <SidebarMenuSubItem
                        key={`folder-${folderName}-${note.id}`}
                        className="group/sub-item"
                      >
                        <SidebarMenuSubButton
                          asChild
                          isActive={isNoteActive(note.id)}
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
                            folderNames={folderNames}
                            isMobile={isMobile}
                            t={t}
                            onStarredChange={(starred) =>
                              updateOrganization.mutate({
                                id: note.id,
                                starred,
                              })
                            }
                            onFolderChange={(folder) =>
                              handleFolderChange(note.id, folder)
                            }
                            onCreateFolder={() => handleCreateFolder(note.id)}
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
    </>
  );
}
