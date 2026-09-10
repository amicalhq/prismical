'use client';

import * as React from 'react';
import { useNavigation, useDesktopCapabilities } from '@prismical/app-client';
import {
  FileText,
  Folder,
  HardDrive,
  Plus,
  Search,
  Settings,
  Keyboard,
  Cpu,
  Wand2,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../ui/command';
import { SidebarMenuButton } from '../ui/sidebar';
import { useShortcut } from '../lib/shortcuts';
import { Kbd } from '../ui/kbd';
import { ShortcutHint } from './shortcut-hint';
import { useFolders, useCreateFolder } from '@prismical/app-client';
import { useTags } from '@prismical/app-client';
import { useNotes, useCreateNote } from '@prismical/app-client';
import { useSearch } from '@prismical/app-client';
import { FolderNameDialog } from './folder-name-dialog';
import { TagHash } from './tag-chip';
import { useTranslation } from 'react-i18next';

// ─── Shared open-state context ────────────────────────────────────────────────

type CommandPaletteContextProps = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const CommandPaletteContext = React.createContext<CommandPaletteContextProps | null>(null);

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  // ⌘K / Ctrl+K — combo comes from the shortcuts registry (lib/shortcuts.ts).
  useShortcut('command-palette', () => setOpen(prev => !prev));

  return (
    <CommandPaletteContext.Provider value={{ open, setOpen }}>
      {children}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  const ctx = React.useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error('useCommandPalette must be used within CommandPaletteProvider');
  }
  return ctx;
}

// ─── Trigger button ───────────────────────────────────────────────────────────

export function CommandPaletteTrigger() {
  const { t } = useTranslation();
  const { setOpen } = useCommandPalette();

  return (
    <SidebarMenuButton
      onClick={() => setOpen(true)}
      size="sm"
      className="cursor-pointer text-sm text-sidebar-foreground"
    >
      <Search className="size-4" />
      <span>{t('navigation.search.trigger')}</span>
      <ShortcutHint shortcut="command-palette" />
    </SidebarMenuButton>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

const SETTINGS_ITEMS = [
  { labelKey: 'navigation.pages.preferences', url: '/settings/preferences', icon: Settings },
  { labelKey: 'navigation.pages.aiModels', url: '/settings/ai-models', icon: Cpu },
  { labelKey: 'navigation.pages.localModels', url: '/settings/local-models', icon: HardDrive },
  { labelKey: 'navigation.pages.shortcuts', url: '/settings/shortcuts', icon: Keyboard },
  { labelKey: 'navigation.pages.skills', url: '/settings/skills', icon: Wand2 },
];

const RECENT_NOTES_COUNT = 5;

export function CommandPalette() {
  const { t } = useTranslation();
  const { open, setOpen } = useCommandPalette();
  const router = useNavigation();
  const [query, setQuery] = React.useState('');

  // Keyboard shortcuts are a desktop-only feature: hide the
  // Shortcuts settings entry on web (only ⌘K ships there). Desktop reports every
  // capability and keeps it. Local models is gated the same
  // way on its own named capability.
  const caps = useDesktopCapabilities();
  const shortcutsSupported = caps.has('global-shortcuts');
  const localModelsSupported = caps.has('local-models');
  const settingsItems = SETTINGS_ITEMS.filter(item => {
    if (item.url === '/settings/shortcuts') return shortcutsSupported;
    if (item.url === '/settings/local-models') return localModelsSupported;
    return true;
  });

  // Reset query when palette closes
  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const close = React.useCallback(() => setOpen(false), [setOpen]);

  const navigate = React.useCallback(
    (url: string) => {
      router.push(url);
      close();
    },
    [router, close]
  );

  const createNote = useCreateNote();
  const onNewNote = React.useCallback(() => {
    createNote.mutate(undefined, { onSuccess: note => navigate(`/notes/${note.id}`) });
  }, [createNote, navigate]);

  const createFolder = useCreateFolder();
  const [createFolderOpen, setCreateFolderOpen] = React.useState(false);
  const onNewFolder = React.useCallback(() => {
    // Close the palette first, then open the folder dialog on the next tick so the two
    // Radix dialogs don't overlap (an opening dialog stacked on a closing one can leave
    // `pointer-events: none` stuck on <body>).
    close();
    setTimeout(() => setCreateFolderOpen(true), 0);
  }, [close]);

  // Live data
  const { data: allFolders = [] } = useFolders();
  const { data: allTags = [] } = useTags();
  const { data: allNotes = [] } = useNotes();

  // Server-side note search — only fires when query is non-empty
  const { data: searchHits = [], isLoading: isSearching } = useSearch(query);

  // Client-side filter for folders and tags (fast, local data)
  const trimmedQuery = query.trim();
  const filteredFolders = trimmedQuery
    ? allFolders.filter(f => matchesQuery(f.name, trimmedQuery))
    : allFolders;
  const filteredTags = trimmedQuery
    ? allTags.filter(t => matchesQuery(t.name, trimmedQuery))
    : allTags;

  // When empty, show the most-recently-updated notes as "Recent"
  const recentNotes = React.useMemo(
    () =>
      [...allNotes]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, RECENT_NOTES_COUNT),
    [allNotes]
  );

  // shouldFilter=false because we own all filtering:
  // - Notes section: server-side via /me/search (non-empty query) or recents (empty)
  // - Folders/Tags: manual client-side substring match above
  // - Quick Actions / Settings: always shown (no filtering needed)
  return (
    <>
      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
        <CommandInput
          placeholder={t('navigation.search.placeholder')}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-[440px]">
          <CommandEmpty>{t('navigation.search.noResults')}</CommandEmpty>

          {/* Notes — server search when query present, recents when empty */}
          <CommandGroup
            heading={trimmedQuery ? t('navigation.search.notes') : t('navigation.search.recent')}
          >
            {trimmedQuery ? (
              isSearching ? (
                <CommandItem
                  value="__searching__"
                  disabled
                  className="text-muted-foreground text-sm"
                >
                  <Search className="mr-2 h-4 w-4 animate-pulse" />
                  <span>{t('navigation.search.searching')}</span>
                </CommandItem>
              ) : (
                searchHits.map(hit => (
                  <CommandItem
                    key={`search:${hit.id}`}
                    value={`search:${hit.id}`}
                    onSelect={() => navigate(`/notes/${hit.noteId}`)}
                    className="cursor-pointer"
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    <span className="flex-1 truncate">
                      {hit.title || hit.contentText.slice(0, 60)}
                    </span>
                  </CommandItem>
                ))
              )
            ) : (
              recentNotes.map(note => (
                <CommandItem
                  key={`recent:${note.id}`}
                  value={`recent:${note.id}`}
                  onSelect={() => navigate(`/notes/${note.id}`)}
                  className="cursor-pointer"
                >
                  {note.emoji ? (
                    <span className="mr-2 text-base leading-none">{note.emoji}</span>
                  ) : (
                    <FileText className="mr-2 h-4 w-4" />
                  )}
                  <span className="flex-1 truncate">{note.title}</span>
                </CommandItem>
              ))
            )}
          </CommandGroup>

          <CommandSeparator />

          {/* Quick actions */}
          <CommandGroup heading={t('navigation.search.quickActions')}>
            <CommandItem value="new note create" onSelect={onNewNote} className="cursor-pointer">
              <Plus className="mr-2 h-4 w-4" />
              <span>{t('navigation.collections.newNote')}</span>
            </CommandItem>
            <CommandItem
              value="new folder create"
              onSelect={onNewFolder}
              className="cursor-pointer"
            >
              <Plus className="mr-2 h-4 w-4" />
              <span>{t('navigation.collections.newFolder')}</span>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          {/* Folders */}
          <CommandGroup heading={t('navigation.search.folders')}>
            {filteredFolders.map(folder => (
              <CommandItem
                key={`folder:${folder.id}`}
                value={`folder:${folder.id}`}
                onSelect={() => navigate(`/notes?folder=${folder.id}`)}
                className="cursor-pointer"
              >
                <Folder className="mr-2 h-4 w-4" />
                <span className="flex-1 truncate">{folder.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />

          {/* Tags */}
          <CommandGroup heading={t('navigation.search.tags')}>
            {filteredTags.map(tag => (
              <CommandItem
                key={`tag:${tag.id}`}
                value={`tag:${tag.id}`}
                onSelect={() => navigate(`/notes?tags=${tag.id}`)}
                className="cursor-pointer"
              >
                <TagHash color={tag.color} name={tag.name} className="flex-1" />
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />

          {/* Settings */}
          <CommandGroup heading={t('navigation.search.settings')}>
            {settingsItems.map(item => (
              <CommandItem
                key={`settings:${item.url}`}
                value={`settings:${item.url}`}
                onSelect={() => navigate(item.url)}
                className="cursor-pointer"
              >
                <item.icon className="mr-2 h-4 w-4" />
                <span className="flex-1 truncate">{t(item.labelKey as never)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>

        {/* Footer hints */}
        <div className="flex items-center justify-end gap-3 border-t px-3 py-1.5 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑↓</Kbd>
            {t('navigation.search.navigate')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd>
            {t('navigation.search.open')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {t('navigation.search.close')}
          </span>
        </div>
      </CommandDialog>

      <FolderNameDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        mode="create"
        pending={createFolder.isPending}
        onSubmit={name =>
          createFolder.mutate(name, {
            onSuccess: folder => {
              setCreateFolderOpen(false);
              router.push(`/notes?folder=${folder.id}`);
            },
          })
        }
      />
    </>
  );
}
