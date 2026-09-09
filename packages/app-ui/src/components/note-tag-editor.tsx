'use client';

import * as React from 'react';
import { Check, Plus, X } from 'lucide-react';
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
import { useCreateTag, useTags } from '@prismical/app-client';
import { useAddNoteTag, useRemoveNoteTag } from '@prismical/app-client';
import { sanitizeTagNameInput } from '../lib/tag-name';
import type { Tag } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';

/**
 * The note's tags, shown as removable chips plus a "+" chip that opens a
 * searchable multi-select. Mirrors the desktop `NoteTagChips` + `TagPicker`.
 * Drives add/remove writes directly via noteId; `selected` is driven by the
 * live note (from the note-tags query cache).
 *
 * The picker is CREATABLE: typing a name with no existing match
 * shows a "Create '<name>'" row that creates the tag, auto-assigns a color from
 * the desktop palette, and attaches it to the note in one action. The input is
 * restricted to letters and numbers inline (disallowed keystrokes are ignored),
 * so the typed name is always a valid tag name.
 */
export function NoteTagEditor({ noteId, selected }: { noteId: string; selected: string[] }) {
  const { t } = useTranslation();
  const { data: allTags = [] } = useTags();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const add = useAddNoteTag(noteId);
  const remove = useRemoveNoteTag(noteId);
  const create = useCreateTag();

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      remove.mutate(id);
    } else {
      add.mutate(id);
    }
  };

  /** Attach an existing tag idempotently (never toggles an already-attached tag off). */
  const attach = (id: string) => {
    if (!selected.includes(id)) add.mutate(id);
  };

  // Look up a tag by name, case-INSENSITIVELY: tag names are addressable
  // case-insensitively on the `/v1` filter, so "Work" and "work" resolve to the
  // same tag rather than fragment into near-duplicates.
  const findByName = React.useCallback(
    (name: string): Tag | undefined =>
      name ? allTags.find(t => t.name.toLowerCase() === name.toLowerCase()) : undefined,
    [allTags]
  );
  const existingMatch = findByName(query);
  // Offer "Create" only for a non-empty query that doesn't already resolve to an existing tag.
  // `query` is always a valid name (letters/numbers only) thanks to `sanitizeTagNameInput`.
  const showCreate = query.length > 0 && !existingMatch;

  const handleCreate = () => {
    if (create.isPending) return; // guard against a double submit (rapid Enter)
    const name = query;
    // Re-check under the latest cache: if the name now resolves to an existing tag
    // (e.g. created moments ago elsewhere), attach it instead of creating a duplicate.
    const dup = findByName(name);
    if (dup) {
      attach(dup.id);
      return;
    }
    // Fire-and-forget with a callback (NOT mutateAsync): cmdk ignores onSelect's return
    // value, so a rejected promise would surface as an unhandled rejection. The global
    // MutationCache.onError still toasts on failure.
    create.mutate(name, { onSuccess: tag => attach(tag.id) });
  };

  const selectedTags = allTags.filter(t => selected.includes(t.id));

  return (
    <>
      {selectedTags.map(tag => (
        <span
          key={tag.id}
          className="inline-flex h-[22px] min-w-0 items-center gap-1.5 rounded-full border px-2 text-2xs font-medium"
          style={{ borderColor: tag.color, color: tag.color }}
        >
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: tag.color }}
          />
          <span className="max-w-32 truncate">{tag.name}</span>
          <button
            type="button"
            aria-label={t('notes.tags.remove', { name: tag.name })}
            onClick={() => toggle(tag.id)}
            className="-mr-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}

      <Popover
        open={open}
        onOpenChange={next => {
          setOpen(next);
          if (!next) setQuery(''); // reset the search when the picker closes
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('notes.tags.add')}
            className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed border-border px-2 text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent"
          >
            <Plus className="h-3 w-3 shrink-0" />
            <span>{t('notes.tags.add')}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-0">
          <Command>
            <CommandInput
              placeholder={t('notes.tags.searchOrCreate')}
              value={query}
              aria-describedby="note-tag-name-hint"
              // Inline-enforce the charset: strip any disallowed keystroke as it's typed.
              onValueChange={v => setQuery(sanitizeTagNameInput(v))}
            />
            <p id="note-tag-name-hint" className="px-3 pt-1.5 text-2xs text-muted-foreground">
              {t('notes.tags.lettersNumbersOnly')}
            </p>
            <CommandList>
              {/* Hide the empty state while a Create row is on screen (the create
                  row is force-mounted and doesn't count toward cmdk's filter tally). */}
              {!showCreate && <CommandEmpty>{t('notes.tags.notFound')}</CommandEmpty>}
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
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="flex-1 truncate">{tag.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {showCreate && (
                <CommandGroup forceMount>
                  {/* Keep the create group visible even when no existing tag matches. */}
                  <CommandItem
                    key="__create-tag__"
                    value={`create:${query}`}
                    forceMount
                    disabled={create.isPending}
                    onSelect={handleCreate}
                    className="flex items-center gap-2"
                  >
                    <Plus className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">
                      {t('notes.tags.create', { name: query })}
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
