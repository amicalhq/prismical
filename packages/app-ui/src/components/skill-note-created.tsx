'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useCurrentNoteEditor } from '../shell/current-editor-context';
import { useTranslation } from 'react-i18next';
import { useNoteCreatedNotice, activeOrgIdOf, useSessionView } from '@prismical/app-client';

/** Route note-edit feedback through the shared, dock-aware Sonner host. */
export function SkillNoteCreated({ noteId, active = true }: { noteId: string; active?: boolean }) {
  const { t } = useTranslation();
  const { editor, editorNoteId } = useCurrentNoteEditor();
  const session = useSessionView();
  const notice = useNoteCreatedNotice(s => s.notice);
  const ownerKey = session.activeSessionKey ?? session.activeSub;
  const orgId = activeOrgIdOf(session);
  const visit = useRef<{ noteId: string; ownerKey: typeof ownerKey; orgId: typeof orgId } | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    const scope = { noteId, ownerKey, orgId };
    const clearVisit = (leaving: typeof scope) => useNoteCreatedNotice.setState(state => ({
      notice: state.notice?.noteId === leaving.noteId &&
        state.notice.ownerKey === leaving.ownerKey && state.notice.orgId === leaving.orgId
        ? null : state.notice,
    }));
    const previous = visit.current;
    if (previous && (previous.noteId !== noteId || previous.ownerKey !== ownerKey || previous.orgId !== orgId)) {
      clearVisit(previous);
    }
    visit.current = scope;
    mounted.current = true;
    return () => {
      mounted.current = false;
      // React StrictMode replays effects without actually leaving the note.
      queueMicrotask(() => { if (!mounted.current) clearVisit(scope); });
    };
  }, [noteId, ownerKey, orgId]);
  const visible = !!notice && (active || !!notice.undoing || !!notice.undoPending) &&
    notice.noteId === noteId && notice.ownerKey === ownerKey && notice.orgId === orgId;
  const id = visible ? `note-edit-${notice.artifactId}` : null;

  const surface = useRef<{ id: string; active: boolean } | null>(null);
  // A visible lifetime owns its own ID: Sonner defers dismissal, so a previous
  // mount must never dismiss the new toast when the note is reopened quickly.
  useEffect(() => {
    if (!id) return;
    const current = { id: `${id}-${crypto.randomUUID()}`, active: true };
    surface.current = current;
    return () => {
      current.active = false;
      toast.dismiss(current.id);
    };
  }, [id]);
  useEffect(() => {
    if (!visible || !notice || !id) return;
    const current = surface.current;
    if (!current?.active) return;
    const show = notice.error ? toast.error : notice.undoing ? toast.loading :
      notice.undoPending ? toast : toast.success;
    show(notice.message ?? t(notice.undoPending ? 'skills.diff.undoPending' : 'skills.diff.noteCreated'), {
      id: current.id,
      // The store owns the deadline while the user remains on this note.
      duration: Infinity,
      className: 'note-edit-toast',
      description: notice.description,
      closeButton: !notice.undoing,
      dismissible: !notice.undoing,
      onDismiss: () => useNoteCreatedNotice.setState(state => ({
        notice: current.active && state.notice === notice ? null : state.notice,
      })),
      action: notice.undo && !notice.undoing && editor && editorNoteId === noteId ? {
        label: t(notice.undoPending || notice.error ? 'common.actions.retry' : 'skills.diff.undo'),
        onClick: event => {
          // Sonner normally dismisses on action. Keep this toast for Undo progress.
          event.preventDefault();
          if (editor && editorNoteId === noteId) notice.undo?.(editor);
        },
      } : undefined,
    });
  }, [visible, notice, id, editor, editorNoteId, noteId, t]);
  return null;
}
