'use client';

import * as React from 'react';
import { Mic, Sparkles } from 'lucide-react';
import { CommandSeparator } from '../ui/command';
import { useNoteDockActions } from './note-dock-actions';
import type { Editor } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, exitSuggestion, type SuggestionProps } from '@tiptap/suggestion';
import { useSkillDiffStore } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import { Command, CommandGroup, CommandItem, CommandList } from '../ui/command';
import {
  applyBlock,
  canApplyBlock,
  noteBlockActions,
  type NoteBlockAction,
} from './note-editor-actions';

export const noteSlashPluginKey = new PluginKey('noteSlashCommands');
type DockAction = {
  id: 'startRecording' | 'askAi';
  label: string;
  keywords: string;
  icon: typeof Mic;
  run: () => void;
};
type MenuAction = NoteBlockAction | DockAction;
type MenuState = SuggestionProps<MenuAction, MenuAction>;

export function NoteSlashMenu({ editor, noteId }: { editor: Editor; noteId: string }) {
  const { t } = useTranslation();
  const dock = useNoteDockActions(noteId);
  const dockRef = React.useRef(dock);
  dockRef.current = dock;
  const dockItems = React.useMemo<DockAction[]>(
    () => [
      ...(dock?.startRecording
        ? [
            {
              id: 'startRecording' as const,
              label: 'Start recording',
              keywords: 'record microphone transcribe',
              icon: Mic,
              run: dock.startRecording,
            },
          ]
        : []),
      ...(dock?.askAi
        ? [
            {
              id: 'askAi' as const,
              label: 'Ask AI',
              keywords: 'ask ai chat',
              icon: Sparkles,
              run: dock.askAi,
            },
          ]
        : []),
    ],
    [dock]
  );
  const dockItemsRef = React.useRef(dockItems);
  dockItemsRef.current = dockItems;
  const canRecord = !!dock?.startRecording;
  const canAsk = !!dock?.askAi;
  const locked = useSkillDiffStore(s => s.candidatesByNote.has(noteId));
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const [selected, setSelected] = React.useState('');
  const current = React.useRef<MenuState | null>(null);
  const activeId = React.useRef('');
  const listRef = React.useRef<HTMLDivElement>(null);
  const label = React.useCallback(
    (action: MenuAction) =>
      t('run' in action ? `notes.editor.${action.id}` : `notes.editor.blocks.${action.id}`, {
        defaultValue: action.label,
      }),
    [t]
  );
  const dismiss = React.useCallback(() => {
    if (!editor.isDestroyed) exitSuggestion(editor.view, noteSlashPluginKey);
  }, [editor]);
  const choose = React.useCallback(
    (action: MenuAction) => {
      const suggestion = current.current;
      if (
        !suggestion ||
        !editor.isEditable ||
        useSkillDiffStore.getState().candidatesByNote.has(noteId)
      )
        return;
      suggestion.command(action);
    },
    [editor, noteId]
  );

  React.useEffect(() => {
    const update = (suggestion: MenuState) => {
      current.current = suggestion;
      setMenu(suggestion);
      activeId.current = suggestion.items[0]?.id ?? '';
      setSelected(activeId.current);
    };
    editor.registerPlugin(
      Suggestion<MenuAction, MenuAction>({
        editor,
        pluginKey: noteSlashPluginKey,
        char: '/',
        startOfLine: true,
        allow: ({ state, range }) =>
          editor.isEditable &&
          !useSkillDiffStore.getState().candidatesByNote.has(noteId) &&
          state.selection.empty &&
          ['paragraph', 'heading'].includes(state.selection.$from.parent.type.name) &&
          range.from === state.selection.$from.start(),
        items: ({ query }) => {
          const q = query.toLocaleLowerCase();
          const range = {
            from: editor.state.selection.$from.start(),
            to: editor.state.selection.from,
          };
          return [...dockItemsRef.current, ...noteBlockActions].filter(
            action =>
              `${label(action)} ${action.label} ${action.keywords}`
                .toLocaleLowerCase()
                .includes(q) &&
              ('run' in action || canApplyBlock(editor, action, range))
          );
        },
        command: ({ editor: ed, range, props: action }) => {
          if (!ed.isEditable || useSkillDiffStore.getState().candidatesByNote.has(noteId)) return;
          // The trigger must still be at the cursor; don't delete text after focus or a remote edit moved it.
          if (
            ed.state.selection.from !== range.to ||
            !ed.state.doc.textBetween(range.from, range.to).startsWith('/')
          )
            return;
          if ('run' in action) {
            const run = dockRef.current?.[action.id];
            if (!run) return;
            ed.commands.deleteRange(range);
            exitSuggestion(ed.view, noteSlashPluginKey);
            run();
            return;
          }
          applyBlock(ed, action, range);
          exitSuggestion(ed.view, noteSlashPluginKey);
        },
        render: () => ({
          onStart: update,
          onUpdate: update,
          onExit: () => {
            current.current = null;
            setMenu(null);
          },
          onKeyDown: ({ event }) => {
            if (event.isComposing) return false;
            if (event.key === 'Escape' || event.key === 'Tab') {
              dismiss();
              return event.key === 'Escape';
            }
            const items = current.current?.items ?? [];
            if (!items.length) return false;
            const index = Math.max(
              0,
              items.findIndex(item => item.id === activeId.current)
            );
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              const next =
                items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
              if (next) {
                activeId.current = next.id;
                setSelected(next.id);
              }
              return true;
            }
            if (event.key === 'Enter') {
              const item = items[index];
              if (item) choose(item);
              return true;
            }
            return false;
          },
        }),
      }),
      (plugin, plugins) => [plugin, ...plugins]
    );
    const blur = () => dismiss();
    const editableChanged = () => {
      if (!editor.isEditable) dismiss();
    };
    editor.on('update', editableChanged);
    editor.on('blur', blur);
    return () => {
      editor.off('blur', blur);
      editor.off('update', editableChanged);
      editor.unregisterPlugin(noteSlashPluginKey);
    };
  }, [editor, noteId, label, dismiss, choose]);

  React.useEffect(() => {
    dismiss();
  }, [canRecord, canAsk, dismiss]);

  React.useEffect(() => {
    if (locked) dismiss();
  }, [locked, dismiss]);
  React.useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-note-block="${selected}"]`);
    item?.scrollIntoView({ block: 'nearest' });
    const dom = editor.view.dom;
    if (menu && list) dom.setAttribute('aria-controls', list.id);
    if (menu && item) dom.setAttribute('aria-activedescendant', item.id);
    return () => {
      dom.removeAttribute('aria-controls');
      dom.removeAttribute('aria-activedescendant');
    };
  }, [selected, menu, editor]);

  if (!menu || locked || !editor.isEditable) return null;
  const rect = menu.clientRect?.();
  if (!rect) return null;
  return (
    <Popover
      open
      onOpenChange={open => {
        if (!open) dismiss();
      }}
    >
      <PopoverAnchor
        virtualRef={{ current: { getBoundingClientRect: () => menu.clientRect?.() ?? rect } }}
      />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="w-64 p-0"
        aria-label={t('notes.editor.insertBlock', { defaultValue: 'Insert block' })}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
        onFocusOutside={e => {
          if (e.target === editor.view.dom) e.preventDefault();
        }}
        onMouseDown={e => e.preventDefault()}
      >
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={value => {
            activeId.current = value;
            setSelected(value);
          }}
        >
          <CommandList
            ref={listRef}
            aria-label={t('notes.editor.insertBlock', { defaultValue: 'Insert block' })}
          >
            {menu.items.length === 0 && (
              <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
                {t('notes.editor.noBlocks', { defaultValue: 'No matching blocks' })}
              </p>
            )}
            {(['ai', 'blocks'] as const).map(group => {
              const items = menu.items.filter(action => 'run' in action === (group === 'ai'));
              if (!items.length) return null;
              return (
                <React.Fragment key={group}>
                  {group === 'blocks' && menu.items.some(action => 'run' in action) && (
                    <CommandSeparator />
                  )}
                  <CommandGroup
                    heading={
                      group === 'ai'
                        ? t('notes.editor.aiGroup', { defaultValue: 'AI' })
                        : t('notes.editor.insertBlock', { defaultValue: 'Insert block' })
                    }
                  >
                    {items.map(action => (
                      <CommandItem
                        key={action.id}
                        data-note-block={action.id}
                        value={action.id}
                        onSelect={() => choose(action)}
                      >
                        <action.icon />
                        {label(action)}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </React.Fragment>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
