"use client";

import * as React from "react";
import { defaultFilter } from "cmdk";
import { IconHome, IconNotes, IconSearch } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { api } from "@/trpc/react";
import { FileTextIcon, Folder as FolderIcon } from "lucide-react";
import { formatDate } from "@/lib/utils";
import {
  HOME_NAV_ITEMS,
  SETTINGS_NAV_ITEMS,
  type SettingsNavItem,
} from "../lib/settings-navigation";
import { TagHash } from "@/renderer/main/components/tag/tag-hash";

// Detect platform for keyboard shortcuts
const isMac = window.electronAPI.platform === "darwin";

const SHORTCUT_KEY_BY_URL = new Map(
  HOME_NAV_ITEMS.filter((item) => item.shortcutKey).map((item) => [
    item.url,
    item.shortcutKey as string,
  ]),
);

const formatShortcut = (key: string) => (isMac ? `⌘ ${key}` : `Ctrl ${key}`);
const HOME_SEARCH_ITEM: SettingsNavItem = {
  titleKey: "settings.nav.home.title",
  url: "/home",
  descriptionKey: "settings.nav.home.description",
  icon: IconHome,
  type: "settings",
};
const NOTES_SEARCH_ITEM: SettingsNavItem = {
  titleKey: "settings.nav.notes.title",
  url: "/notes",
  descriptionKey: "settings.nav.notes.description",
  icon: IconNotes,
  type: "settings",
};

export function CommandSearchButton() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const navigate = useNavigate();

  const localizedSettings = React.useMemo(
    () =>
      [HOME_SEARCH_ITEM, NOTES_SEARCH_ITEM, ...SETTINGS_NAV_ITEMS].map(
        (page) => ({
          ...page,
          title: t(page.titleKey),
          description: t(page.descriptionKey),
        }),
      ),
    [t, i18n.language],
  );

  // Client-side filtering for settings
  const settingsResults = React.useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) {
      return localizedSettings;
    }
    return localizedSettings.filter((page) => {
      const searchText = [page.title, page.description].join(" ").toLowerCase();
      return searchText.includes(query);
    });
  }, [search, localizedSettings]);

  const { data: noteResults = [] } = api.notes.searchNotes.useQuery(
    { query: search },
    {
      enabled: open,
      staleTime: 1000 * 60 * 5,
    },
  );

  const { data: folderResults = [] } = api.folders.listWithCounts.useQuery(
    { search, sortBy: "name" },
    {
      enabled: open,
      staleTime: 1000 * 60 * 5,
    },
  );

  const { data: tagResults = [] } = api.tags.listWithCounts.useQuery(
    { search, sortBy: "name" },
    {
      enabled: open,
      staleTime: 1000 * 60 * 5,
    },
  );

  const topFolders = React.useMemo(
    () => folderResults.slice(0, 8),
    [folderResults],
  );
  const topTags = React.useMemo(() => tagResults.slice(0, 8), [tagResults]);

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const shortcutDisplay = isMac ? "⌘ K" : "Ctrl+K";

  const filter = React.useCallback(
    (_value: string, search: string, keywords?: string[]) => {
      if (!keywords || keywords.length === 0) return 0;
      return defaultFilter(keywords.join(" "), search, undefined) ?? 0;
    },
    [],
  );

  const closeAndReset = React.useCallback(() => {
    setOpen(false);
    setSearch("");
  }, []);

  const handleSelectUrl = (url: string) => {
    closeAndReset();
    navigate({ to: url });
  };

  const handleSelectFolder = (id: number) => {
    closeAndReset();
    navigate({
      to: "/notes",
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        folder: id,
        tags: undefined,
      })) as never,
    });
  };

  const handleSelectTag = (id: number) => {
    closeAndReset();
    navigate({
      to: "/notes",
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        tags: [id],
        folder: undefined,
      })) as never,
    });
  };

  return (
    <>
      <SidebarMenuButton
        onClick={() => setOpen(true)}
        className="cursor-pointer"
      >
        <IconSearch />
        <span>{t("settings.search.buttonLabel")}</span>
        <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground ml-auto">
          {shortcutDisplay}
        </kbd>
      </SidebarMenuButton>

      <CommandDialog open={open} onOpenChange={setOpen} filter={filter}>
        <CommandInput
          placeholder={t("settings.search.inputPlaceholder")}
          value={search}
          onValueChange={setSearch}
        />
        <CommandList className="max-h-[440px]">
          <CommandEmpty>{t("settings.search.noResults")}</CommandEmpty>
          {settingsResults.length > 0 && (
            <CommandGroup heading={t("settings.search.settingsHeading")}>
              {settingsResults.map((page) => {
                const shortcutKey = SHORTCUT_KEY_BY_URL.get(page.url);
                return (
                  <CommandItem
                    key={page.url}
                    value={`settings-${page.url}`}
                    keywords={[page.title, page.description]}
                    onSelect={() => handleSelectUrl(page.url)}
                    className="cursor-pointer"
                  >
                    <page.icon className="mr-2 h-4 w-4" />
                    <span className="flex-1 truncate">{page.title}</span>
                    {shortcutKey && (
                      <kbd className="pointer-events-none ml-2 inline-flex h-5 select-none items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                        {formatShortcut(shortcutKey)}
                      </kbd>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          {noteResults.length > 0 && (
            <CommandGroup heading={t("settings.search.notesHeading")}>
              {noteResults.map((note) => (
                <CommandItem
                  key={`note:${note.id}`}
                  value={`note-${note.id}`}
                  keywords={[note.title]}
                  onSelect={() => handleSelectUrl(`/notes/${note.id}`)}
                  className="cursor-pointer"
                >
                  {note.icon ? (
                    <span className="mr-2 text-base leading-none">{note.icon}</span>
                  ) : (
                    <FileTextIcon className="mr-2 h-4 w-4" />
                  )}
                  <span className="flex-1 truncate">{note.title}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                    {formatDate(new Date(note.createdAt))}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {topFolders.length > 0 && (
            <CommandGroup heading={t("settings.search.foldersHeading")}>
              {topFolders.map((folder) => (
                <CommandItem
                  key={`folder:${folder.id}`}
                  value={`folder-${folder.id}`}
                  keywords={[folder.name]}
                  onSelect={() => handleSelectFolder(folder.id)}
                  className="cursor-pointer"
                >
                  <FolderIcon className="mr-2 h-4 w-4" />
                  <div className="flex flex-1 items-center justify-between">
                    <span className="font-medium">{folder.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {folder.noteCount}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {topTags.length > 0 && (
            <CommandGroup heading={t("settings.search.tagsHeading")}>
              {topTags.map((tag) => (
                <CommandItem
                  key={`tag:${tag.id}`}
                  value={`tag-${tag.id}`}
                  keywords={[tag.name]}
                  onSelect={() => handleSelectTag(tag.id)}
                  className="cursor-pointer"
                >
                  <div className="flex flex-1 items-center justify-between">
                    <TagHash color={tag.color} name={tag.name} />
                    <span className="text-xs text-muted-foreground">
                      {tag.noteCount}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <div className="flex items-center justify-end gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">↵</kbd>
            {t("settings.search.hintOpen")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">↑↓</kbd>
            {t("settings.search.hintNavigate")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">Esc</kbd>
            {t("settings.search.hintClose")}
          </span>
        </div>
      </CommandDialog>
    </>
  );
}
