'use client';

import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { Lock } from 'lucide-react';
import type * as Y from 'yjs';
import { useNoteCollab } from '@prismical/app-client';
import { startLoadingTiming } from '@prismical/app-client';
import { buildWebEditorExtensions } from '@prismical/app-client';
import { useRegisterNoteEditor } from '../shell/current-editor-context';
import { useSkillDiffDecorations } from '@prismical/app-client';
import { InlineSkillPopover } from './inline-skill-popover';
import { NoteBodySkeleton } from './skeletons';
import './note-body-editor.css';
import './artifact-node.css';
import './diff-styles.css';
import { useTranslation } from 'react-i18next';

interface NoteBodyEditorProps {
  noteId: string;
  writable: boolean;
}

/**
 * How long the bars stand on their own before they admit something may be wrong. Long enough that
 * a normal connect never shows it, short enough to beat a user's patience.
 */
const SLOW_COLLAB_MS = 10_000;

function Loading() {
  const { t } = useTranslation();
  // Shaped like the text that is about to arrive rather than a spinner over empty space: the body
  // is the whole point of the screen, so an outline of it reads as loading, while a spinner on a
  // blank page reads as stalled. The label stays for screen readers, which get nothing from bars.
  //
  // But bars alone are only honest while the wait is normal. `useNoteCollab` surfaces `error` only
  // after repeated AUTH failures — a connect that simply never syncs (the note service wedged)
  // leaves this mounted forever, and endless shimmering bars claim there is content on the way.
  // After a while, say so in words.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_COLLAB_MS);
    return () => clearTimeout(id);
  }, []);
  return (
    <div role="status" aria-busy="true" aria-label={t('notes.editor.loading')}>
      <span className="sr-only">{t('notes.editor.loading')}</span>
      <NoteBodySkeleton />
      {slow ? (
        <p className="ml-1 mt-3 text-xs text-muted-foreground">{t('notes.editor.slowConnect')}</p>
      ) : null}
    </div>
  );
}

export function NoteBodyEditor({ noteId, writable }: NoteBodyEditorProps) {
  const { t } = useTranslation();
  const { doc, status, synced, ready = synced, scope, error, localSaved, localSaveError, remotePending, loadingAttemptId } = useNoteCollab(noteId);

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
  if (!doc || !ready) {
    if (localSaveError) return <p role="alert" className="text-sm text-destructive">{t('notes.editor.localSaveError')}</p>;
    if (status === 'disconnected') return <p role="status" className="text-sm text-muted-foreground">{t('notes.editor.offlineUnavailable')}</p>;
    return <Loading />;
  }

  // Writability = core's canWrite snapshot AND the connection's live scope.
  // The scope is authoritative: a readonly connection's edits are silently
  // dropped server-side, so a stale canWrite=true must not enable typing.
  const canEdit = writable && scope !== 'readonly';

  return (
    <div>
      {localSaveError ? (
        <p role="alert" className="mb-2 text-sm text-destructive">{t('notes.editor.localSaveError')}</p>
      ) : localSaved ? (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          {t(synced && !remotePending ? 'notes.editor.synced' : 'notes.editor.savedLocally')}
        </p>
      ) : null}
      <NoteBodyEditorInner
        doc={doc}
        noteId={noteId}
        status={status}
        writable={canEdit}
        loadingAttemptId={loadingAttemptId}
      />
    </div>
  );
}

interface InnerProps {
  doc: Y.Doc;
  noteId: string;
  status: 'connecting' | 'connected' | 'disconnected';
  writable: boolean;
  loadingAttemptId?: string;
}

function NoteBodyEditorInner({
  doc,
  noteId,
  status,
  writable,
  loadingAttemptId,
}: InnerProps) {
  const { t } = useTranslation();
  const placeholder = t('notes.editor.placeholder');
  const loading = useRef<ReturnType<typeof startLoadingTiming> | null>(null);
  useEffect(() => {
    // Passive browser diagnostics only; this does not add analytics traffic or
    // publish the editor before document sync. The parent id distinguishes a
    // replacement collaboration document from the prior note mount.
    const timing = startLoadingTiming(
      undefined,
      'note_editor',
      noteId,
      undefined,
      loadingAttemptId
    );
    loading.current = timing;
    return () => {
      timing.finish('abandoned');
    };
  }, [doc, noteId, loadingAttemptId]);
  const editor: Editor | null = useEditor(
    {
      extensions: buildWebEditorExtensions(doc, noteId, placeholder),
      editable: false, // toggled below once the editor exists
      immediatelyRender: false, // Next.js SSR: avoid a hydration mismatch
      editorProps: {
        attributes: { class: 'note-prose w-full text-note-foreground' },
      },
    },
    [doc, noteId, placeholder]
  );

  // Only a hydrated local body is published. Reconnects do not withdraw it.
  // Publish the live editor to the layout-level dock so the skill run/diff/accept flow can drive it.
  useRegisterNoteEditor(noteId, editor);

  // Apply/clear the diff overlay when a skill candidate is staged/cleared for this note. Also gated:
  // previewing against the pre-sync empty doc would fail and (for inline-rewrite) claim the user's
  // selection had been deleted when the document simply had not arrived.
  useSkillDiffDecorations(editor, noteId);

  // Local hydration enables editing; provider reconnects do not interrupt typing.
  useEffect(() => {
    editor?.setEditable(writable);
    try {
      if (editor) loading.current?.mark('editor_created');
      if (editor && writable && !editor.isDestroyed) {
        loading.current?.mark('editor_editability_set');
        if (editor.view.dom.isConnected) {
          loading.current?.mark('editor_dom_mounted');
          if (editor.view.dom.getAttribute('contenteditable') === 'true') {
            loading.current?.mark('editor_editable');
            loading.current?.finish('ready');
          }
        }
      }
    } catch {
      // A detached editor view leaves the diagnostic phase unknown.
    }
  }, [editor, writable]);

  if (!editor) return <Loading />;

  return (
    <div className="w-full">
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
