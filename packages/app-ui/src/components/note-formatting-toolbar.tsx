'use client';

import * as React from 'react';
import { posToDOMRect, type Editor } from '@tiptap/react';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link2,
  ChevronDown,
  Wand2,
  Check,
  Unlink,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSkillDiffStore } from '@prismical/app-client';
import { Button } from '../ui/button';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from '../ui/input-group';
import { Separator } from '../ui/separator';
import { skillDisplayName } from '../lib/skill-presentation';
import {
  applyBlock,
  canApplyBlock,
  noteBlockActions,
  normalizeEditorLink,
} from './note-editor-actions';
import { useInlineSelectionSkills } from './use-inline-selection-skills';

const marks = [
  { name: 'bold', label: 'Bold', icon: Bold },
  { name: 'italic', label: 'Italic', icon: Italic },
  { name: 'strike', label: 'Strikethrough', icon: Strikethrough },
  { name: 'code', label: 'Inline code', icon: Code },
] as const;

export function NoteFormattingToolbar({ editor, noteId }: { editor: Editor; noteId: string }) {
  const { t } = useTranslation();
  const locked = useSkillDiffStore(s => s.candidatesByNote.has(noteId));
  const [open, setOpen] = React.useState(false);
  const [, redraw] = React.useReducer(n => n + 1, 0);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [link, setLink] = React.useState('');
  const [linkError, setLinkError] = React.useState(false);
  const content = React.useRef<HTMLDivElement>(null);
  const { skills, runInline, available } = useInlineSelectionSkills(editor, noteId);
  const canEdit = () =>
    editor.isEditable && !useSkillDiffStore.getState().candidatesByNote.has(noteId);
  const anchor = React.useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => {
          const { from, to } = editor.state.selection;
          return posToDOMRect(editor.view, from, to);
        },
      },
    }),
    [editor]
  );

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      redraw();
      const selection = editor.state.selection;
      const valid =
        editor.isEditable &&
        (selection instanceof TextSelection || selection instanceof AllSelection) &&
        !selection.empty &&
        !!editor.state.doc.textBetween(selection.from, selection.to, ' ').trim();
      if (!valid) {
        setOpen(false);
        setLinkOpen(false);
      } else if (editor.isFocused) setOpen(true);
    };
    const blur = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const target = document.activeElement;
        if (
          target instanceof Element &&
          target.closest('[data-note-editor-menu]')?.getAttribute('data-note-editor-menu') ===
            noteId
        )
          return;
        if (target === editor.view.dom) return;
        setOpen(false);
        setLinkOpen(false);
      }, 0);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'F10' && !editor.state.selection.empty) {
        event.preventDefault();
        content.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    };
    editor.on('transaction', update);
    editor.on('update', update);
    editor.on('focus', update);
    editor.on('blur', blur);
    editor.view.dom.addEventListener('keydown', keydown);
    return () => {
      clearTimeout(timer);
      editor.off('transaction', update);
      editor.off('update', update);
      editor.off('focus', update);
      editor.off('blur', blur);
      editor.view.dom.removeEventListener('keydown', keydown);
    };
  }, [editor, noteId]);

  const restoreFocus = (event: Event) => {
    event.preventDefault();
    if (!editor.isDestroyed) editor.commands.focus();
  };
  const block =
    noteBlockActions.find(
      a =>
        a.id.startsWith('heading') && editor.isActive('heading', { level: Number(a.id.slice(-1)) })
    ) ??
    noteBlockActions.find(
      a => !['paragraph', 'divider', 'table'].includes(a.id) && editor.isActive(a.id)
    ) ??
    noteBlockActions[0];

  return (
    <Popover
      open={open && !locked && editor.isEditable}
      onOpenChange={value => {
        setOpen(value);
        if (!value) setLinkOpen(false);
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        ref={content}
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="w-auto max-w-[calc(100vw-24px)] p-1"
        data-note-editor-menu={noteId}
        aria-label={t('notes.editor.toolbar', { defaultValue: 'Text formatting' })}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
        onFocusOutside={e => {
          if (e.target === editor.view.dom) e.preventDefault();
        }}
      >
        <div
          role="group"
          aria-label={t('notes.editor.toolbar', { defaultValue: 'Text formatting' })}
          className="flex flex-wrap items-center gap-0.5"
        >
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('notes.editor.blockType', { defaultValue: 'Change block type' })}
              >
                {t(`notes.editor.blocks.${block.id}`, { defaultValue: block.label })}
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              data-note-editor-menu={noteId}
              align="start"
              onCloseAutoFocus={restoreFocus}
            >
              <DropdownMenuGroup>
                {noteBlockActions
                  .filter(a => a.id !== 'table' && a.id !== 'divider')
                  .map(action => (
                    <DropdownMenuItem
                      key={action.id}
                      disabled={!canApplyBlock(editor, action)}
                      onSelect={() => {
                        if (canEdit()) applyBlock(editor, action);
                      }}
                    >
                      <action.icon />
                      {t(`notes.editor.blocks.${action.id}`, { defaultValue: action.label })}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Separator orientation="vertical" className="mx-1 h-5" />
          {marks.map(mark => (
            <Button
              key={mark.name}
              variant={editor.isActive(mark.name) ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={t(`notes.editor.${mark.name}`, { defaultValue: mark.label })}
              title={t(`notes.editor.${mark.name}`, { defaultValue: mark.label })}
              aria-pressed={editor.isActive(mark.name)}
              disabled={!editor.can().toggleMark(mark.name)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                if (canEdit()) editor.chain().focus().toggleMark(mark.name).run();
              }}
            >
              <mark.icon />
            </Button>
          ))}
          <Popover
            open={linkOpen}
            onOpenChange={value => {
              setLinkOpen(value);
              setLinkError(false);
              if (value) setLink(editor.getAttributes('link').href ?? '');
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant={editor.isActive('link') ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-label={t('notes.editor.link', { defaultValue: 'Edit link' })}
                title={t('notes.editor.link', { defaultValue: 'Edit link' })}
              >
                <Link2 />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              data-note-editor-menu={noteId}
              className="w-80 max-w-[calc(100vw-24px)] p-2"
              onCloseAutoFocus={restoreFocus}
            >
              <form
                aria-label={t('notes.editor.link', { defaultValue: 'Edit link' })}
                onSubmit={e => {
                  e.preventDefault();
                  const href = normalizeEditorLink(link);
                  if (href === null) {
                    setLinkError(true);
                    return;
                  }
                  if (!canEdit()) return;
                  const chain = editor.chain().focus();
                  const result = href ? chain.setLink({ href }).run() : chain.unsetLink().run();
                  if (!result) {
                    setLinkError(true);
                    return;
                  }
                  setLinkOpen(false);
                }}
              >
                <InputGroup>
                  <InputGroupInput
                    autoFocus
                    aria-label={t('notes.editor.linkUrl', { defaultValue: 'Link URL' })}
                    placeholder={t('notes.editor.linkUrl')}
                    value={link}
                    aria-invalid={linkError}
                    onChange={e => {
                      setLink(e.target.value);
                      setLinkError(false);
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      aria-label={t('notes.editor.saveLink', { defaultValue: 'Save link' })}
                    >
                      <Check />
                    </InputGroupButton>
                    <InputGroupButton
                      size="icon-sm"
                      aria-label={t('notes.editor.removeLink', { defaultValue: 'Remove link' })}
                      onClick={() => {
                        if (canEdit()) editor.chain().focus().unsetLink().run();
                        setLinkOpen(false);
                      }}
                    >
                      <Unlink />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {linkError && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {t('notes.editor.invalidLink', {
                      defaultValue: 'Enter a valid web, email, or phone link.',
                    })}
                  </p>
                )}
              </form>
            </PopoverContent>
          </Popover>
          {skills.length > 0 && available && (
            <>
              <Separator orientation="vertical" className="mx-1 h-5" />
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <Wand2 data-icon="inline-start" />
                    {t('notes.editor.skills', { defaultValue: 'Skills' })}
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  data-note-editor-menu={noteId}
                  align="end"
                  onCloseAutoFocus={e => e.preventDefault()}
                >
                  <DropdownMenuGroup>
                    {skills.map(skill => (
                      <DropdownMenuItem
                        key={skill.id}
                        onSelect={() => {
                          runInline(skill.id, skillDisplayName(skill, t));
                          setOpen(false);
                        }}
                      >
                        <Wand2 />
                        {skillDisplayName(skill, t)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
