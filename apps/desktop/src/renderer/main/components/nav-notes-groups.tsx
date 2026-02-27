import * as React from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronRight, FileText, Folder, Star } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
} from "@/components/ui/sidebar";

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

export function NavNotesGroups({ notes }: { notes: NoteNavigationItem[] }) {
  const { t } = useTranslation();
  const location = useLocation();

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
