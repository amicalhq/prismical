'use client';

import { useEffect, useReducer } from 'react';
import type { Editor } from '@tiptap/react';
import { Undo2, Redo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  subscribeEditorHistory,
  useSkillDiffStore,
  useWorkflowSnapshot,
} from '@prismical/app-client';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export function NoteHistoryControls({
  editor,
  noteId,
  writable,
}: {
  editor: Editor | null;
  noteId: string;
  writable: boolean;
}) {
  const { t } = useTranslation();
  const [, redraw] = useReducer(n => n + 1, 0);
  const reviewing = useSkillDiffStore(s => s.candidatesByNote.has(noteId));
  const workflow = useWorkflowSnapshot();
  const applying =
    workflow.kind === 'skill' && workflow.noteId === noteId && workflow.phase === 'applying';
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const unsubscribe = subscribeEditorHistory(editor, redraw);
    redraw();
    return unsubscribe;
  }, [editor]);
  const available =
    !!editor && !editor.isDestroyed && editor.isEditable && writable && !reviewing && !applying;
  const apple =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

  return (
    <div className="flex shrink-0 items-center gap-0">
      {(['undo', 'redo'] as const).map(action => {
        const label = t(`desktop.menu.${action}`);
        const shortcut = `${apple ? '⌘' : 'Ctrl+'}${action === 'redo' ? (apple ? '⇧' : 'Shift+') : ''}Z`;
        const Icon = action === 'undo' ? Undo2 : Redo2;
        const enabled = available && editor.can()[action]();
        return (
          <Tooltip key={action}>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-7 shrink-0 p-0 hover:bg-accent"
                  aria-label={label}
                  aria-keyshortcuts={`${apple ? 'Meta' : 'Control'}+${action === 'redo' ? 'Shift+' : ''}Z`}
                  disabled={!enabled}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => {
                    if (!enabled || !editor || editor.isDestroyed || !editor.can()[action]())
                      return;
                    // Focus the view without dispatching a fresh selection transaction into history.
                    editor.commands[action]();
                    editor.view.focus();
                  }}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {label} · {shortcut}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
