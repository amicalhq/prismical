'use client';

import * as React from 'react';
import { Check, Star, Tag as TagIcon, X } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../lib/utils';
import { TagBadge, TagHash } from '../shell/tag-chip';
import { useTags } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// How many selected chips to show in the trigger before collapsing the rest
// into a "+N" indicator (desktop measures dynamically; a fixed cap is a close,
// simpler equivalent for this fixed-width pill).
const VISIBLE_CHIPS = 2;

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

  // `selected` comes from the URL, and the host commits a URL change ASYNCHRONOUSLY (a router push
  // plus its re-render). Between a pick and that commit `selected` still holds the PREVIOUS value,
  // so a second pick computed from it would replace the first instead of adding to it — picking two
  // tags quickly used to leave only the last one. Hold the picks made since the last commit here and
  // compute every toggle from those; the local copy is released the moment the URL catches up (or
  // changes underneath us: back/forward, a sidebar tag link).
  const [pending, setPending] = React.useState<string[] | null>(null);
  const pendingCommits = React.useRef<string[]>([]);
  const committed = selected.join(',');
  React.useEffect(() => {
    const acknowledged = pendingCommits.current.indexOf(committed);
    if (acknowledged < 0) pendingCommits.current = [];
    else pendingCommits.current.splice(0, acknowledged + 1);
    // An earlier URL acknowledgment must not erase picks made after it.
    // An unrelated value comes from navigation and replaces the pending filter.
    if (pendingCommits.current.length === 0) setPending(null);
  }, [committed]);
  const active = pending ?? selected;

  const apply = (ids: string[]) => {
    pendingCommits.current.push(ids.join(','));
    setPending(ids);
    onChange(ids);
  };
  const toggle = (id: string) =>
    apply(active.includes(id) ? active.filter(x => x !== id) : [...active, id]);

  // By name, like the other tag surfaces — the sync lane hands rows back in update order, which
  // reads as random once a user has more than a handful of tags.
  const tags = [...allTags].sort((a, b) => a.name.localeCompare(b.name));

  // A selected id that resolves to no tag still filters the list (ids are ANDed), so it must stay
  // visible: it is why the page looks empty, and its chip is what makes the filter clearable. It is
  // NOT dropped from the filter — the tag list can be legitimately behind (a tag another device just
  // made, a link opened before the first pull), and silently widening a filter the user asked for
  // would show every note instead of the ones they came for.
  const selectedTags = active.map(
    id => tags.find(tag => tag.id === id) ?? { id, name: t('notes.tags.unknown'), color: null }
  );
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
                <TagBadge
                  key={tag.id}
                  color={tag.color}
                  name={tag.name}
                  nameClassName="max-w-20"
                />
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
              {tags.map(tag => {
                const isSelected = active.includes(tag.id);
                return (
                  <CommandItem
                    key={tag.id}
                    value={tag.name}
                    keywords={[tag.name]}
                    onSelect={() => toggle(tag.id)}
                    className="flex items-center gap-2"
                  >
                    <TagHash color={tag.color} name={tag.name} className="flex-1" />
                    {tag.favorite && (
                      <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
                    )}
                    {/* Trailing, not leading: an always-mounted leading check reserved
                        24px of indent on every row, so the hashes sat in from the edge
                        instead of leading the row the way they do in the sidebar. */}
                    <Check
                      className={cn('h-4 w-4 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {active.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    onSelect={() => apply([])}
                    className="flex items-center gap-2 text-muted-foreground"
                  >
                    <X className="h-4 w-4 shrink-0" />
                    <span>{t('notes.tags.clear')}</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
