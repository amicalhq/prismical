'use client';

import * as React from 'react';
import { CornerDownRight, Folder, FolderPlus } from 'lucide-react';
import { AppLink as Link } from '../shell/app-link';
import {
  useFolders,
  useNavigation,
  useNotes,
  useSearchParams,
} from '@prismical/app-client';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { counterChipClass, FolderChipLabel, folderChipClass } from './folder-chip';
import { contextMenuKit, FolderMenuItems, useFolderActions } from './folder-menu';
import {
  buildFolderTree,
  folderAncestry,
  levelOf,
  MAX_FOLDER_DEPTH,
  type FolderNode,
} from '../lib/folder-tree';
import { useFitCount } from '../hooks/use-fit-count';
import { withNotesFolder } from '../lib/notes-filter-url';
import { isFolderShared } from '../lib/folder-sharing';
import { cn } from '../lib/utils';
import { useTranslation } from 'react-i18next';

/**
 * The folders at the level the notes list is showing: the top-level folders at the root, a
 * folder's own children inside it. A chip goes one level down; the breadcrumb above the toolbar
 * goes up. Together they are the whole explorer, and the notes page stays the one place notes are
 * listed.
 *
 * One line, never more. The chips that fit are drawn; the rest fold into a counter that opens a
 * searchable list of this level, so a client with thirty subfolders still gets one row and a
 * search. Alphabetical, so the order is stable enough to learn.
 *
 * The strip also holds the create chip: a new top-level folder at the root, a subfolder inside a
 * folder. That is why an empty root still draws the strip, otherwise a fresh account has nowhere
 * to make its first folder.
 */
interface FoldersStripProps {
  /** The folder whose children to show; `null` for the top level. */
  parentId: string | null;
}

export function FoldersStrip({ parentId }: FoldersStripProps) {
  const { t } = useTranslation();
  const router = useNavigation();
  const searchParams = useSearchParams();
  const { data: folders = [], isLoading } = useFolders();
  const { data: notes = [] } = useNotes();
  // A chip's right-click menu and the create chip share one set of dialogs.
  const actions = useFolderActions();

  const tree = React.useMemo(() => {
    const direct = new Map<string, number>();
    for (const note of notes) {
      if (note.folderId) direct.set(note.folderId, (direct.get(note.folderId) ?? 0) + 1);
    }
    return buildFolderTree(folders, id => direct.get(id) ?? 0);
  }, [folders, notes]);
  const level = React.useMemo(() => levelOf(tree, parentId), [tree, parentId]);
  const ancestry = React.useMemo(
    () => (parentId ? folderAncestry(folders, parentId) : []),
    [folders, parentId]
  );
  const parent = ancestry[ancestry.length - 1];

  // A subfolder needs its parent to be known and room under the depth cap: the
  // ancestry's length is how many tiers the new folder would sit beneath.
  const canCreate =
    parentId === null || (!!parent && ancestry.length < MAX_FOLDER_DEPTH);

  // Names what the row holds: the chips, and whether the create chip ends it. Either changing
  // re-measures, so a create chip that arrives after its parent loads is
  // budgeted rather than clipped.
  const signature =
    level.map(node => `${node.folder.id}:${node.folder.name}:${node.noteCount}`).join('|') +
    (canCreate ? '|new' : '');
  const { containerRef, counterRef, trailingRef, itemRef, fit } = useFitCount(
    level.length,
    signature
  );
  const hidden = level.slice(fit);

  // The dialogs stay mounted through a hidden strip, so a confirmation is never torn out mid-close.
  if (isLoading || (level.length === 0 && !canCreate)) return <>{actions.dialogs}</>;

  return (
    <nav aria-label={t('folders.title')} className="mb-6 flex items-center gap-2">
      {/* A bent arrow, not a label: these are the folders one step in from the heading. */}
      <CornerDownRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <div
        ref={containerRef}
        className="relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
      >
        {level.map((node, index) => {
          const shown = index < fit;
          return (
            <ContextMenu key={node.folder.id}>
              <ContextMenuTrigger asChild>
                <Link
                  ref={itemRef(index)}
                  href={withNotesFolder(searchParams, node.folder.id)}
                  // Out of the flow, not unmounted: the chip has to stay measurable.
                  className={cn(
                    folderChipClass('sm', { interactive: true }),
                    !shown && 'invisible absolute'
                  )}
                  aria-hidden={shown ? undefined : true}
                  tabIndex={shown ? undefined : -1}
                >
                  <FolderChipLabel
                    size="sm"
                    name={node.folder.name}
                    count={node.noteCount}
                    shared={isFolderShared(folders, node.folder.id)}
                    sharedLabel={t('folders.shared')}
                    nameClassName="max-w-40"
                  />
                </Link>
              </ContextMenuTrigger>
              {/* Sized to its longest label - see the note on the tag row's menu. */}
              <ContextMenuContent className="w-max max-w-72 min-w-48 rounded-lg">
                <FolderMenuItems
                  folder={node.folder}
                  tree={tree}
                  actions={actions}
                  kit={contextMenuKit}
                />
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {level.length > 0 ? (
          // The counter's stand-in: out of the flow, but measurable, so the row always knows how
          // much room a counter takes before it overflows. Its label is the widest the real one
          // could be, so a counter never needs more than this, whatever is folded right now.
          <span
            ref={counterRef}
            aria-hidden="true"
            className={cn(counterChipClass, 'invisible absolute')}
          >
            +{level.length}
          </span>
        ) : null}
        {hidden.length > 0 ? (
          <MoreFolders
            nodes={hidden}
            parentName={parent?.name}
            onPick={id => router.push(withNotesFolder(searchParams, id))}
          />
        ) : null}
        {canCreate ? (
          <span ref={trailingRef} className="inline-flex shrink-0">
            <button
              type="button"
              onClick={() => actions.createIn(parent ? { id: parent.id, name: parent.name } : null)}
              aria-label={parent ? t('folders.newSubfolder') : t('folders.new')}
              className={cn(
                folderChipClass('sm', { interactive: true, dashed: true }),
                'cursor-pointer'
              )}
            >
              <FolderPlus className="size-3.5 shrink-0" />
              <span>{t('folders.newChip')}</span>
            </button>
          </span>
        ) : null}
      </div>

      {actions.dialogs}
    </nav>
  );
}

/**
 * The count of folders that did not fit, opening a searchable list of them. Only the ones left
 * out: the counter says "+N", and the list is those N.
 */
function MoreFolders({
  nodes,
  parentName,
  onPick,
}: {
  nodes: FolderNode[];
  parentName?: string;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('folders.more', { count: nodes.length })}
          className={cn(
            counterChipClass,
            'cursor-pointer transition-colors hover:bg-muted-foreground/20'
          )}
        >
          +{nodes.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput
            placeholder={parentName ? t('folders.findIn', { name: parentName }) : t('folders.find')}
          />
          <CommandList>
            <CommandEmpty>{t('folders.noMatch')}</CommandEmpty>
            <CommandGroup>
              {nodes.map(node => (
                <CommandItem
                  key={node.folder.id}
                  value={node.folder.id}
                  keywords={[node.folder.name]}
                  onSelect={() => {
                    setOpen(false);
                    onPick(node.folder.id);
                  }}
                  className="flex items-center gap-2"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{node.folder.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('folders.noteCount', { count: node.noteCount })}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
