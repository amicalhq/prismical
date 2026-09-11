'use client';

import * as React from 'react';
import { Check, Folder as FolderIcon, FolderPlus } from 'lucide-react';
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

// "Parent / Child" path so same-named siblings disambiguate (mirrors the
// desktop NoteFolderChip / FolderPicker).
import type { Folder } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';

function folderPath(all: Folder[], id: string): string {
  const folder = folderById(all, id);
  if (!folder) return '';
  return folder.parentId ? `${folderPath(all, folder.parentId)} / ${folder.name}` : folder.name;
}

/**
 * The note's folder, shown as a chip that opens a searchable picker. Mirrors the
 * desktop `NoteFolderChip`: pick a folder or clear it ("No folder"). Controlled
 * via `value` / `onChange`.
 */
export function NoteFolderChip({
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
          aria-label={selected ? t('notes.folders.change') : t('notes.folders.add')}
          className={cn(
            'inline-flex h-[22px] items-center gap-1 rounded-sm border px-2 text-2xs font-medium transition-colors',
            // Outlined, not filled: a filled chip here was bg-muted + text-muted-foreground
            // + border-border, which is how disabled controls are drawn — the folder NAME,
            // real content, was painted in the placeholder colour. Outline + foreground text
            // also keeps it distinct from the tag badges beside it, which own the fills.
            // The outline is --border: --surface-raised is #fcfcfd in light, the exact value of
            // --background, so that chip had no visible edge outside dark.
            selected
              ? 'border-border text-foreground hover:bg-surface-raised'
              : 'border-dashed border-border text-muted-foreground hover:bg-surface-raised hover:text-foreground'
          )}
        >
          {selected ? (
            <>
              <FolderIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="max-w-40 truncate">{folderPath(folders, selected.id)}</span>
            </>
          ) : (
            <>
              <FolderPlus className="h-3 w-3 shrink-0" />
              <span>{t('notes.folders.add')}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t('notes.folders.search')} />
          <CommandList>
            <CommandEmpty>{t('notes.folders.notFound')}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={t('notes.folders.none')}
                onSelect={() => select(null)}
                className="flex items-center gap-2"
              >
                <Check className={cn('h-4 w-4 shrink-0', !value ? 'opacity-100' : 'opacity-0')} />
                <span className="flex-1 text-muted-foreground">{t('notes.folders.none')}</span>
              </CommandItem>
              {folders.map(folder => (
                <CommandItem
                  key={folder.id}
                  value={folder.id}
                  keywords={[folderPath(folders, folder.id)]}
                  onSelect={() => select(folder.id)}
                  className="flex items-center gap-2"
                >
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      value === folder.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{folderPath(folders, folder.id)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
