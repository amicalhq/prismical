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
import { FolderChipLabel, folderChipClass } from './folder-chip';
import { useFolders, folderById } from '@prismical/app-client';
import { moveLeavesSharedFolder } from '../lib/folder-sharing';
import { MoveOutOfSharedDialog } from '../shell/move-out-of-shared-dialog';

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
  // A move out of a shared folder takes the team's access to the note with it, so it asks first.
  const [leaving, setLeaving] = React.useState<{ id: string | null } | null>(null);

  const select = (id: string | null) => {
    setOpen(false);
    if (moveLeavesSharedFolder(folders, value, id)) {
      setLeaving({ id });
      return;
    }
    onChange(id);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={selected ? t('notes.folders.change') : t('notes.folders.add')}
          // The shared folder chip, so the note's folder reads the same as on a note row and the
          // folders strip; dashed while the note has no folder, like the strip's create chip.
          className={cn(
            folderChipClass('xs', { interactive: true, dashed: !selected }),
            'cursor-pointer'
          )}
        >
          {selected ? (
            <FolderChipLabel name={folderPath(folders, selected.id)} nameClassName="max-w-40" />
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
      <MoveOutOfSharedDialog
        open={leaving !== null}
        what="note"
        onCancel={() => setLeaving(null)}
        onConfirm={() => {
          if (leaving) onChange(leaving.id);
          setLeaving(null);
        }}
      />
    </Popover>
  );
}
