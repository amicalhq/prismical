'use client';

import * as React from 'react';
import { Check, ListFilter, Pencil, Plus, X } from 'lucide-react';
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
import { TagBadge, TagHash } from '../shell/tag-chip';
import { useAllNoteTags, useCreateTag, useNavigation, useTags, useUpdateTag } from '@prismical/app-client';
import { useAddNoteTag, useRemoveNoteTag } from '@prismical/app-client';
import { sanitizeTagNameInput } from '../lib/tag-name';
import { TagEditDialog } from '../shell/tag-edit-dialog';
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
const TAG_ACTION =
  'inline-flex h-[22px] max-w-full items-center gap-1 rounded-sm border border-border px-2 text-2xs font-medium transition-colors';

export function NoteTagEditor({ noteId, selected }: { noteId: string; selected: string[] }) {
  const { t } = useTranslation();
  const { data: allTags = [] } = useTags();
  const noteTags = useAllNoteTags();
  const noteCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of noteTags.data ?? []) {
      counts.set(link.tagId, (counts.get(link.tagId) ?? 0) + 1);
    }
    return counts;
  }, [noteTags.data]);
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

  // Walk `selected`, don't filter `allTags`: `note.tagIds` arrives in note-tag LINK order
  // (oldest link first), while useTags() sorts the whole collection by the TAG's own
  // updatedAt. Filtering adopted that second order, so renaming or recolouring a tag bumped
  // its updatedAt and silently moved its chip on every note carrying it. Link order also
  // means a newly added tag appends at the end, which is where it appears as you add it.
  const selectedTags = selected
    .map(id => allTags.find(t => t.id === id))
    .filter((t): t is Tag => t !== undefined);

  return (
    <>
      {selectedTags.map(tag => (
        <NoteTagChip key={tag.id} tag={tag} noteCount={noteCounts.get(tag.id) ?? 0} onRemove={() => toggle(tag.id)} />
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
            className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-dashed border-border px-2 text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent"
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
                      <TagHash color={tag.color} name={tag.name} className="flex-1" />
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

/**
 * One of the note's tags, as a chip that opens the tag itself: its colour and note count, a link
 * to every note carrying it, a rename/recolour dialog, and "Remove from note".
 *
 * Remove lives in here rather than as an X on the chip. The X sat inside a 22px chip at 14px
 * square, which is well under a comfortable target and put a destructive action one stray click
 * from the tag name. Deleting the tag itself is deliberately NOT offered here — that is a
 * workspace-wide action and belongs in the sidebar row, not beside a single note's chips.
 */
function NoteTagChip({ tag, noteCount, onRemove }: { tag: Tag; noteCount: number; onRemove: () => void }) {
  const { t } = useTranslation();
  const router = useNavigation();
  const [open, setOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const editTag = useUpdateTag();

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <TagBadge
            interactive
            color={tag.color}
            name={tag.name}
            nameClassName="max-w-32"
            aria-label={tag.name}
          />
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" sideOffset={6} className="w-64 p-0">
          <div className="flex items-center gap-2 p-3">
            <TagHash color={tag.color} name={tag.name} className="min-w-0 flex-1" />
            <span className="shrink-0 text-xs text-muted-foreground">
              {t('notes.tags.noteCount', { count: noteCount })}
            </span>
          </div>
          <div className="flex flex-wrap gap-1 border-t border-border p-2">
            <button
              type="button"
              className={cn(TAG_ACTION, 'hover:bg-surface-raised')}
              onClick={() => {
                setOpen(false);
                router.push(`/notes?tags=${tag.id}`);
              }}
            >
              <ListFilter className="h-3 w-3" aria-hidden="true" />
              {t('notes.tags.viewNotes')}
            </button>
            <button
              type="button"
              className={cn(TAG_ACTION, 'hover:bg-surface-raised')}
              onClick={() => {
                setOpen(false);
                setEditOpen(true);
              }}
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />
              {t('dialogs.tag.title')}
            </button>
            <button
              type="button"
              className={cn(TAG_ACTION, 'hover:bg-surface-raised')}
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              <X className="h-3 w-3" aria-hidden="true" />
              {t('notes.tags.removeFromNote')}
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <TagEditDialog
        tag={editOpen ? tag : null}
        onOpenChange={setEditOpen}
        pending={editTag.isPending}
        onSubmit={patch =>
          editTag.mutate({ id: tag.id, patch }, { onSuccess: () => setEditOpen(false) })
        }
      />
    </>
  );
}
