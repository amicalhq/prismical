'use client';

import * as React from 'react';
import { Check, Folder as FolderIcon, Star } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../lib/utils';
import { useFolders, folderById } from '@prismical/app-client';
import type { Folder } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';

// "Parent / Child" path so same-named siblings disambiguate and the trigger
// shows the full path (mirrors the desktop FolderPicker).
function folderPath(all: Folder[], id: string): string {
  const folder = folderById(all, id);
  if (!folder) return '';
  return folder.parentId ? `${folderPath(all, folder.parentId)} / ${folder.name}` : folder.name;
}

/**
 * Single-select folder picker for the /notes browser — a searchable combobox.
 * Mirrors the desktop `FolderPicker` (which replaced the old folder rail).
 * Controlled via `value` / `onChange`; `null` means "All folders".
 */
export function NotesFolderPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const { data: folders = [] } = useFolders();
  const selected = value ? folderById(folders, value) : null;

  const select = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('notes.folders.filter')}
          className="flex h-9 w-44 shrink-0 items-center gap-2 rounded-lg bg-muted px-3 text-sm transition-colors hover:bg-accent"
        >
          <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className={cn('flex-1 truncate text-left', !selected && 'text-muted-foreground')}>
            {selected ? folderPath(folders, selected.id) : t('notes.folders.all')}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t('notes.folders.search')} />
          <CommandList>
            <CommandEmpty>{t('notes.folders.notFound')}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={t('notes.folders.all')}
                onSelect={() => select(null)}
                className="flex items-center gap-2"
              >
                <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{t('notes.folders.all')}</span>
                <Check className={cn('h-4 w-4 shrink-0', !value ? 'opacity-100' : 'opacity-0')} />
              </CommandItem>
              {folders.map(folder => (
                <CommandItem
                  key={folder.id}
                  value={folder.id}
                  keywords={[folderPath(folders, folder.id)]}
                  onSelect={() => select(folder.id)}
                  className="flex items-center gap-2"
                >
                  <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{folderPath(folders, folder.id)}</span>
                  {folder.favorite && (
                    <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
                  )}
                  {/* Trailing check, like the tag filter: a leading one reserves 24px of
                      indent on every row, pushing the folder icons in from the edge. */}
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      value === folder.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
