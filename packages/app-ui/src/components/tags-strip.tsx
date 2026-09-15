'use client';

import * as React from 'react';
import { Check, X } from 'lucide-react';
import { useAllNoteTags, useNotes, useTags } from '@prismical/app-client';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { TagHash } from '../shell/tag-chip';
import { counterChipClass, folderChipClass } from './folder-chip';
import { useFitCount } from '../hooks/use-fit-count';
import { usePendingSelection } from '../hooks/use-pending-selection';
import { cn } from '../lib/utils';
import { useTranslation } from 'react-i18next';

/**
 * The tag filter as a row of toggle pills in the toolbar. A folder is where you are, a tag is
 * what you filter by, so tags sit with the filters rather than in a second strip under the
 * folders: a folder chip navigates and the strip changes under you; a tag pill toggles and the
 * row stays.
 *
 * Scoped to the view: only tags carried by the notes listed here (the folder's subtree, or every
 * note at the root), ordered by how many notes carry them, with the selected ones first so a
 * filter is always visible and clearable. One line, never more: the pills that fit are drawn and
 * the rest fold into a searchable "+N" list. Multi-select stays AND.
 *
 * The same chip shape as the folders strip, drawn the way a tag is drawn everywhere else in the
 * app: the coloured hash, then the name. The hash is what says "tag" the way the folder icon says
 * "folder"; a selected chip takes the tinted fill the tag badge on a note already uses.
 */
interface TagsStripProps {
  selected: string[];
  onChange: (ids: string[]) => void;
  /** The notes in view are the ones in these folders; every note when omitted. */
  folderIds?: string[];
  className?: string;
}

interface Pill {
  id: string;
  name: string;
  color: string | null;
  count: number;
  selected: boolean;
}

export function TagsStrip({ selected, onChange, folderIds, className }: TagsStripProps) {
  const { t } = useTranslation();
  const { data: tags = [] } = useTags();
  const { data: notes = [] } = useNotes();
  // Tags reach a note through the note-tag join, the same way the list hydrates its rows: the note
  // rows themselves carry no tag ids.
  const { data: noteTags = [] } = useAllNoteTags();
  const { active, apply, toggle } = usePendingSelection(selected, onChange);

  const scopeKey = folderIds?.join(',');
  const activeKey = active.join(',');
  // The row's order is fixed while you toggle: a pill that jumped to the front on every click
  // would make a multi-select a chase, and the fill colour already says which are on. Selected
  // tags lead only when the view changes (a folder, a link into a filter), which is when a filter
  // you did not just set needs to be visible: the selection is captured once per scope and ranks
  // the row until the scope changes again, whatever the notes or the toggles do meanwhile.
  const leadRef = React.useRef<{ scopeKey: string | undefined; lead: ReadonlySet<string> }>({
    scopeKey,
    lead: new Set(active),
  });
  if (leadRef.current.scopeKey !== scopeKey) {
    leadRef.current = { scopeKey, lead: new Set(active) };
  }
  const lead = leadRef.current.lead;
  const order = React.useMemo(() => {
    // An empty scope is a view with no notes in it, so no tags; `undefined` is every note.
    const scope = scopeKey === undefined ? null : new Set(scopeKey ? scopeKey.split(',') : []);
    const inView = new Set<string>();
    for (const note of notes) {
      if (scope && !(note.folderId && scope.has(note.folderId))) continue;
      inView.add(note.id);
    }
    const counts = new Map<string, number>();
    for (const { noteId, tagId } of noteTags) {
      if (inView.has(noteId)) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
    const byId = new Map(tags.map(tag => [tag.id, tag]));
    return [...counts.entries()]
      .filter(([id]) => byId.has(id))
      .map(([id, count]) => ({ id, name: byId.get(id)!.name, color: byId.get(id)!.color, count }))
      .sort(
        (a, b) =>
          Number(lead.has(b.id)) - Number(lead.has(a.id)) ||
          b.count - a.count ||
          a.name.localeCompare(b.name)
      );
  }, [lead, noteTags, notes, scopeKey, tags]);

  const pills = React.useMemo<Pill[]>(() => {
    const selected = new Set(activeKey ? activeKey.split(',') : []);
    const known = new Set(order.map(row => row.id));
    // A selected id the view does not carry (a tag no note here has, or one the tag list cannot
    // resolve) still filters the list, so it stays visible and clearable. It leads the row: it
    // only ever arrives by navigation, never by a toggle, so it moves nothing under the cursor.
    const byId = new Map(tags.map(tag => [tag.id, tag]));
    const extra: Pill[] = [...selected]
      .filter(id => !known.has(id))
      .map(id => ({
        id,
        name: byId.get(id)?.name ?? t('notes.tags.unknown'),
        color: byId.get(id)?.color ?? null,
        count: 0,
        selected: true,
      }));
    return [...extra, ...order.map(row => ({ ...row, selected: selected.has(row.id) }))];
  }, [activeKey, order, tags, t]);

  const signature = pills
    .map(pill => `${pill.id}:${pill.name}:${pill.count}:${pill.selected}`)
    .join('|');
  const { containerRef, counterRef, trailingRef, itemRef, fit } = useFitCount(
    pills.length,
    signature
  );
  const hidden = pills.slice(fit);

  if (pills.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t('notes.tags.filter')}
      ref={containerRef}
      className={cn('relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden', className)}
    >
      {pills.map((pill, index) => {
        const shown = index < fit;
        return (
          <button
            key={pill.id}
            ref={itemRef(index)}
            type="button"
            aria-pressed={pill.selected}
            onClick={() => toggle(pill.id)}
            title={pill.name}
            // Out of the flow, not unmounted: the pill has to stay measurable.
            className={cn(tagPillClass(pill.selected), !shown && 'invisible absolute')}
            style={pill.selected && pill.color ? selectedPillStyle(pill.color) : undefined}
            aria-hidden={shown ? undefined : true}
            tabIndex={shown ? undefined : -1}
          >
            <TagHash color={pill.color} name={pill.name} size="xs" className="max-w-40" />
            {pill.selected ? (
              <X aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <span aria-hidden="true" className="shrink-0 tabular-nums text-muted-foreground">
                {pill.count}
              </span>
            )}
          </button>
        );
      })}
      {/* The counter's stand-in: out of the flow, but measurable, so the row always knows how much
          room a counter takes before it overflows. Labelled for the widest it could be. */}
      <span
        ref={counterRef}
        aria-hidden="true"
        className={cn(counterChipClass, 'invisible absolute')}
      >
        +{pills.length}
      </span>
      {hidden.length > 0 ? <MoreTags pills={hidden} onToggle={toggle} /> : null}
      {active.length > 0 ? (
        // Ends the row, so the fit arithmetic budgets it like the folders strip's create chip.
        <span ref={trailingRef} className="inline-flex shrink-0">
          <button
            type="button"
            onClick={() => apply([])}
            className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('notes.tags.clear')}
          </button>
        </span>
      ) : null}
    </div>
  );
}

function tagPillClass(selected: boolean): string {
  return cn(
    folderChipClass('sm', { interactive: !selected }),
    'cursor-pointer',
    selected && 'border-transparent bg-muted-foreground/15'
  );
}

/** A selected chip fills with its tag's colour, faint enough for the name to stay readable. */
function selectedPillStyle(color: string): React.CSSProperties {
  return { backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)` };
}

/** The tags that did not fit, in a searchable list that toggles them like the pills do. */
function MoreTags({ pills, onToggle }: { pills: Pill[]; onToggle: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('notes.tags.more', { count: pills.length })}
          className={cn(
            counterChipClass,
            'cursor-pointer transition-colors hover:bg-muted-foreground/20'
          )}
        >
          +{pills.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t('notes.tags.search')} />
          <CommandList>
            <CommandEmpty>{t('notes.tags.notFound')}</CommandEmpty>
            <CommandGroup>
              {pills.map(pill => (
                <CommandItem
                  key={pill.id}
                  value={pill.name}
                  keywords={[pill.name]}
                  onSelect={() => onToggle(pill.id)}
                  className="flex items-center gap-2"
                >
                  <TagHash color={pill.color} name={pill.name} className="flex-1" />
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('notes.tags.noteCount', { count: pill.count })}
                  </span>
                  <Check
                    className={cn('size-4 shrink-0', pill.selected ? 'opacity-100' : 'opacity-0')}
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
