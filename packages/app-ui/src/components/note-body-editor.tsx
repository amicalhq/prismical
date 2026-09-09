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
  const { doc, status, synced, scope, error, loadingAttemptId } = useNoteCollab(noteId);

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
      loadingAttemptId={loadingAttemptId}
    />
  );
}

interface InnerProps {
  doc: Y.Doc;
  noteId: string;
  status: 'connecting' | 'connected' | 'disconnected';
  synced: boolean;
  writable: boolean;
  loadingAttemptId?: string;
}

function NoteBodyEditorInner({
  doc,
  noteId,
  status,
  synced,
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
      editable: false, // toggled below once writable/synced are known
      immediatelyRender: false, // Next.js SSR: avoid a hydration mismatch
      editorProps: {
        attributes: { class: 'note-prose w-full text-note-foreground' },
      },
    },
    [doc, noteId, placeholder]
  );

  // The Y.Doc exists from the first render but is EMPTY until y-sync loads the body, and the editor
  // is created before that. Publishing it early would let the dock accept a staged skill result into
  // a document that has not loaded: replace-doc would snapshot an empty body (making its Undo a
  // note-wipe) and then merge the proposal with the real content once sync landed. Sticky, not the
  // live `synced` flag - once the body is here a routine reconnect must not yank the review pill.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (synced) setLoaded(true);
  }, [synced]);
  const liveEditor = loaded ? editor : null;

  // Publish the live editor to the layout-level dock so the skill run/diff/accept flow can drive it.
  useRegisterNoteEditor(noteId, liveEditor);

  // Apply/clear the diff overlay when a skill candidate is staged/cleared for this note. Also gated:
  // previewing against the pre-sync empty doc would fail and (for inline-rewrite) claim the user's
  // selection had been deleted when the document simply had not arrived.
  useSkillDiffDecorations(liveEditor, noteId);

  // Editable only when we own write access and the doc has synced. A transient
  // disconnect deliberately keeps it editable: Yjs buffers offline edits and
  // resyncs on reconnect (no data loss).
  useEffect(() => {
    editor?.setEditable(writable && synced);
    try {
      if (editor) loading.current?.mark('editor_created');
      if (editor && writable && synced && !editor.isDestroyed) {
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
  }, [editor, writable, synced]);

  if (!editor || !synced) return <Loading />;

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
