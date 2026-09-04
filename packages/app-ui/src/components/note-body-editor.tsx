'use client';

import { useEffect } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { Loader2, Lock } from 'lucide-react';
import type * as Y from 'yjs';
import { useNoteCollab } from '@prismical/app-client';
import { buildWebEditorExtensions } from '@prismical/app-client';
import { useRegisterNoteEditor } from '../shell/current-editor-context';
import { useSkillDiffDecorations } from '@prismical/app-client';
import { InlineSkillPopover } from './inline-skill-popover';
import './note-body-editor.css';
import './artifact-node.css';
import './diff-styles.css';
import { useTranslation } from 'react-i18next';

interface NoteBodyEditorProps {
  noteId: string;
  writable: boolean;
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {t('notes.editor.loading')}
    </div>
  );
}

export function NoteBodyEditor({ noteId, writable }: NoteBodyEditorProps) {
  const { t } = useTranslation();
  const { doc, status, synced, scope, error } = useNoteCollab(noteId);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-8 text-sm text-muted-foreground">
        <Lock className="h-4 w-4 shrink-0" />
        {t('notes.editor.openError')}
      </div>
    );
  }

  // The editor is only created once the Y.Doc exists — otherwise the schema would
  // have no nodes ("missing top node type 'doc'"). The inner component owns the
  // editor so its useEditor hook always receives a valid doc.
  if (!doc) return <Loading />;

  // Writability = core's canWrite snapshot AND the connection's live scope.
  // The scope is authoritative: a readonly connection's edits are silently
  // dropped server-side, so a stale canWrite=true must not enable typing.
  const canEdit = writable && scope !== 'readonly';

  return (
    <NoteBodyEditorInner
      doc={doc}
      noteId={noteId}
      status={status}
      synced={synced}
      writable={canEdit}
    />
  );
}

interface InnerProps {
  doc: Y.Doc;
  noteId: string;
  status: 'connecting' | 'connected' | 'disconnected';
  synced: boolean;
  writable: boolean;
}

function NoteBodyEditorInner({ doc, noteId, status, synced, writable }: InnerProps) {
  const { t } = useTranslation();
  const placeholder = t('notes.editor.placeholder');
  const editor: Editor | null = useEditor(
    {
      extensions: buildWebEditorExtensions(doc, noteId, placeholder),
      editable: false, // toggled below once writable/synced are known
      immediatelyRender: false, // Next.js SSR: avoid a hydration mismatch
      editorProps: {
        attributes: { class: 'note-prose max-w-2xl text-note-foreground' },
      },
    },
    [doc, noteId, placeholder]
  );

  // Publish the live editor to the layout-level dock so the skill run/diff/accept flow can drive it.
  useRegisterNoteEditor(noteId, editor);

  // Apply/clear the diff overlay when a skill candidate is staged/cleared for this note.
  useSkillDiffDecorations(editor, noteId);

  // Editable only when we own write access and the doc has synced. A transient
  // disconnect deliberately keeps it editable: Yjs buffers offline edits and
  // resyncs on reconnect (no data loss).
  useEffect(() => {
    editor?.setEditable(writable && synced);
  }, [editor, writable, synced]);

  if (!editor || !synced) return <Loading />;

  return (
    <div className="max-w-2xl">
      {!writable && (
        <p className="mb-2 rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          {t('notes.editor.readOnly')}
        </p>
      )}
      {status === 'disconnected' && (
        <p className="mb-2 text-xs text-warning">{t('notes.editor.reconnecting')}</p>
      )}
      <EditorContent editor={editor} />
      {/* Selection → inline-rewrite entry point; write access only. */}
      {writable && <InlineSkillPopover editor={editor} noteId={noteId} />}
    </div>
  );
}
