'use client';

import * as React from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import * as Y from 'yjs';
import {
  buildWebEditorExtensions,
  useNote,
  useNoteCollab,
  useSkillDiffStore,
  type NoteCollab,
} from '@prismical/app-client';
import { SkillDiffDockBar, SkillDiffPendingBar } from './skill-diff-dock-bar';

interface Props {
  hostKey: string;
  noteId: string;
  compact: boolean;
  onEditor: (hostKey: string, editor: Editor | null) => void;
  sourceEditor: Editor | null;
}

/** One temporary original-note editor, owned by the dock rather than the visible route. */
export function SkillProposalHost(props: Props) {
  const collab = useNoteCollab(props.noteId);
  const { data: note } = useNote(props.noteId);
  const candidate = useSkillDiffStore(s => s.candidatesByNote.get(props.noteId));
  React.useEffect(() => {
    const source = props.sourceEditor?.extensionManager.extensions.find(
      extension => extension.name === 'collaboration'
    )?.options.document as Y.Doc | undefined;
    const target = collab.doc;
    if (!source || !target || source === target) return;
    // Include local keystrokes which the visible editor has not sent yet. Both documents address
    // the same Yjs items, so server delivery of these updates later remains idempotent.
    Y.applyUpdate(target, Y.encodeStateAsUpdate(source), 'proposal-source');
    const forward = (update: Uint8Array) => Y.applyUpdate(target, update, 'proposal-source');
    source.on('update', forward);
    return () => {
      source.off('update', forward);
    };
  }, [collab.doc, props.sourceEditor]);
  if (!collab.doc) {
    return candidate ? (
      <SkillDiffPendingBar
        noteId={props.noteId}
        skillName={candidate.skillName}
        compact={props.compact}
      />
    ) : null;
  }
  return (
    <ProposalEditor
      key={collab.doc.guid}
      {...props}
      collab={collab}
      writable={!!note && note.writable !== false && collab.scope === 'read-write'}
    />
  );
}

function ProposalEditor({
  hostKey,
  noteId,
  compact,
  onEditor,
  collab,
  writable,
  sourceEditor,
}: Props & {
  collab: NoteCollab;
  writable: boolean;
}) {
  const editor = useEditor(
    {
      extensions: buildWebEditorExtensions(collab.doc!, noteId, ''),
      immediatelyRender: false,
      editable: false,
    },
    [collab.doc, noteId]
  );
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    if (collab.synced) setLoaded(true);
  }, [collab.synced]);
  const available = loaded && writable && !collab.error && !!editor && !editor.isDestroyed;
  React.useEffect(() => {
    onEditor(hostKey, available ? editor : null);
    return () => onEditor(hostKey, null);
  }, [hostKey, available, editor, onEditor]);
  const { hasWriteAccess, waitForPendingChanges } = collab;
  const access = React.useRef(available);
  access.current = available;
  const canApply = React.useCallback(
    () => access.current && hasWriteAccess(),
    [hasWriteAccess]
  );
  const beforeApplyComplete = React.useCallback(async () => {
    if (!canApply()) throw new Error('The original note is not writable.');
    await waitForPendingChanges();
    if (!canApply()) throw new Error('The original note is not writable.');
  }, [waitForPendingChanges, canApply]);
  const candidate = useSkillDiffStore(s => s.candidatesByNote.get(noteId));

  return (
    <>
      {/* A real editor view keeps the collaboration binding and artifact commands available. It
        never registers as the page editor or takes the current note's focus. */}
      <div hidden aria-hidden="true">
        <EditorContent editor={editor} />
      </div>
      {candidate &&
        (available && editor ? (
          <SkillDiffDockBar
            editor={editor}
            noteId={noteId}
            compact={compact}
            beforeApplyComplete={beforeApplyComplete}
            canApply={canApply}
            restoreEditor={sourceEditor}
          />
        ) : (
          <SkillDiffPendingBar noteId={noteId} skillName={candidate.skillName} compact={compact} />
        ))}
    </>
  );
}
