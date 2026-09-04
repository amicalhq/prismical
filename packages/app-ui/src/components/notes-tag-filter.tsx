'use client';

import * as React from 'react';
import { Check, Star, Tag as TagIcon } from 'lucide-react';
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
import { useTags } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// How many selected chips to show in the trigger before collapsing the rest
// into a "+N" indicator (desktop measures dynamically; a fixed cap is a close,
// simpler equivalent for this fixed-width pill).
const VISIBLE_CHIPS = 2;

// Tag colors are oklch, so we can't append a hex alpha like the desktop does;
// color-mix gives the same translucent fill.
function chipStyle(color: string): React.CSSProperties {
  return {
    color,
    backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`,
  };
}

/**
 * Multi-select tag filter for the /notes browser — a chips combobox: selected
 * tags render as inline chips in the trigger, and the dropdown is a searchable
 * list of all tags with favorite + note-count. Mirrors the desktop
 * `TagFilterBar`. Controlled via `selected` / `onChange` (the page owns the URL).
 */
export function NotesTagFilter({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const { data: allTags = [] } = useTags();
  const [open, setOpen] = React.useState(false);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);

  const selectedTags = allTags.filter(t => selected.includes(t.id));
  const visible = selectedTags.slice(0, VISIBLE_CHIPS);
  const overflow = selectedTags.length - visible.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('notes.tags.filter')}
          className="flex h-9 min-w-[150px] max-w-[260px] flex-1 items-center gap-1 overflow-hidden rounded-lg bg-muted px-2.5 text-sm transition-colors hover:bg-accent"
        >
          {selectedTags.length === 0 ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <TagIcon className="h-4 w-4 shrink-0" />
              <span>{t('notes.tags.title')}</span>
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1">
              {visible.map(tag => (
                <span
                  key={tag.id}
                  className="flex h-[22px] shrink-0 items-center gap-0.5 rounded-sm px-1.5 text-xs font-medium"
                  style={chipStyle(tag.color)}
                >
                  <span className="font-mono font-bold leading-none">#</span>
                  <span className="max-w-20 truncate">{tag.name}</span>
                </span>
              ))}
              {overflow > 0 && (
                <span className="shrink-0 px-0.5 text-xs text-muted-foreground">+{overflow}</span>
              )}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t('notes.tags.search')} />
          <CommandList>
            <CommandEmpty>{t('notes.tags.notFound')}</CommandEmpty>
            <CommandGroup>
              {allTags.map(tag => {
                const isSelected = selected.includes(tag.id);
                return (
                  <CommandItem
                    key={tag.id}
                    value={tag.name}
                    keywords={[tag.name]}
                    onSelect={() => toggle(tag.id)}
                    className="flex items-center gap-2"
                  >
                    <Check
                      className={cn('h-4 w-4 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                    />
                    <span
                      aria-hidden
                      className="font-mono text-sm font-bold leading-none"
                      style={{ color: tag.color, width: 12, textAlign: 'center' }}
                    >
                      #
                    </span>
                    <span className="flex-1 truncate">{tag.name}</span>
                    {tag.favorite && (
                      <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
