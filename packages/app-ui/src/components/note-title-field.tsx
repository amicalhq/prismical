'use client';

import * as React from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { firstNoteLine, markdownToTiptapJson } from '@prismical/editor-markdown';
import { NAME_NOTE_SKILL_ID, type Note } from '@prismical/app-contracts';
import {
  useRunSkill,
  useSkillsList,
  useUpdateNote,
  setTitleDraftDirty,
  useTitleTranscriptAvailable,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';
import { useCurrentNoteEditor } from '../shell/current-editor-context';
import { skillDisplayName } from '../lib/skill-presentation';

const subscribeOnline = (notify: () => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
};

export function NoteTitleField({
  note,
  compact = false,
  onTitleChange,
}: {
  note: Note;
  compact?: boolean;
  onTitleChange?: (title: string) => void;
}) {
  const { t } = useTranslation();
  const online = React.useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true
  );
  const active = useCurrentNoteEditor();
  const editor = active.editorNoteId === note.id ? active.editor : null;
  const [firstLine, setFirstLine] = React.useState('');
  React.useEffect(() => {
    const read = () => {
      try {
        setFirstLine(firstNoteLine(editor?.getJSON() ?? markdownToTiptapJson(note.body)));
      } catch {
        setFirstLine('');
      }
    };
    read();
    editor?.on('update', read);
    return () => {
      editor?.off('update', read);
    };
  }, [editor, note.body]);
  const follows = note.titleSource === 'placeholder' || note.titleSource === 'first-line';
  const resolvedTitle = follows ? firstLine || t('notes.emptyTitle') : note.title;
  const [draft, setDraft] = React.useState(resolvedTitle);
  const dirty = React.useRef(false);
  const cancelled = React.useRef(false);
  const owner = React.useRef(Symbol('note-title'));
  const markDirty = (value: boolean) => {
    dirty.current = value;
    setTitleDraftDirty(note.id, owner.current, value);
  };
  React.useEffect(() => {
    if (!dirty.current) setDraft(resolvedTitle);
  }, [resolvedTitle]);
  React.useEffect(() => {
    const token = owner.current;
    return () => setTitleDraftDirty(note.id, token, false);
  }, [note.id]);
  React.useEffect(() => onTitleChange?.(draft), [draft, onTitleChange]);
  const update = useUpdateNote(note.id);
  const { data: skills = [] } = useSkillsList();
  const skill = skills.find(
    s => s.id === NAME_NOTE_SKILL_ID && s.enabled && s.config.outputTarget === 'note-title'
  );
  const naming = useRunSkill(note.id, editor);
  const hasTranscript = useTitleTranscriptAvailable(note.id, !firstLine && note.writable !== false);
  const hasContent = Boolean(firstLine || hasTranscript.data);
  const disabled = !online || note.writable === false || !skill || !hasContent;
  const label = !online
    ? t('notes.titleOffline')
    : !hasContent
      ? t('notes.titleNeedsContent')
      : t('notes.nameWithAI');

  return (
    <div
      className={`group/title flex min-w-0 items-center gap-1 ${compact ? 'max-w-full' : 'flex-1'}`}
      style={compact ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
    >
      <input
        value={draft}
        readOnly={note.writable === false}
        aria-label={t('notes.title')}
        placeholder={t('notes.emptyTitle')}
        style={
          compact
            ? ({ fieldSizing: 'content', maxWidth: '100%' } as React.CSSProperties)
            : undefined
        }
        onFocus={() => {
          cancelled.current = false;
        }}
        onChange={event => {
          setDraft(event.target.value);
          markDirty(event.target.value !== resolvedTitle);
        }}
        onBlur={() => {
          if (cancelled.current) {
            setDraft(resolvedTitle);
            markDirty(false);
            return;
          }
          if (dirty.current) update.mutate({ title: draft.trim() });
          markDirty(false);
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            cancelled.current = true;
            event.currentTarget.blur();
          }
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className={
          compact
            ? 'min-w-[4ch] truncate bg-transparent text-[12.5px] font-medium text-dock-ink-3 outline-none focus:text-dock-ink'
            : 'min-w-0 flex-1 bg-transparent px-2 pt-1 text-2xl font-semibold leading-tight text-foreground outline-none placeholder:text-muted-foreground md:text-3xl'
        }
      />
      <button
        type="button"
        disabled={!naming.running && disabled}
        aria-label={naming.running ? t('skills.dock.stopRun') : t('notes.nameWithAI')}
        title={naming.running ? t('notes.namingTitle') : label}
        className={`flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 ${naming.running ? '' : 'opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-within/title:opacity-100 [@media(hover:none)]:opacity-100'}`}
        onClick={() => {
          if (naming.running) naming.cancel();
          else if (skill)
            void naming.run({
              skillId: skill.id,
              skillName: skillDisplayName(skill, t),
              outputTarget: 'note-title',
            });
        }}
      >
        {naming.running ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
      </button>
    </div>
  );
}
