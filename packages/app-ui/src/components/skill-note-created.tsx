"use client";

import { useCurrentNoteEditor } from '../shell/current-editor-context';
import { useTranslation } from 'react-i18next';
import { useNoteCreatedNotice, activeOrgIdOf, useSessionView } from '@prismical/app-client';

export function SkillNoteCreated({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const { editor, editorNoteId } = useCurrentNoteEditor();
  const session = useSessionView();
  const notice = useNoteCreatedNotice(s => s.notice);
  if (!notice || notice.noteId !== noteId || notice.ownerKey !== (session.activeSessionKey ?? session.activeSub) ||
      notice.orgId !== activeOrgIdOf(session)) return null;
  return <div role="status" className={`pointer-events-auto mb-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${notice.undoPending ? 'border-transparent bg-dock-surface text-dock-ink-2' : 'border-success/25 bg-dock-surface text-success'}`}>
    <span>{t(notice.undoPending ? 'skills.diff.undoPending' : 'skills.diff.noteCreated')}</span>
    <button type="button" disabled={!editor || editorNoteId !== noteId} onClick={() => { if (editor && editorNoteId === noteId) notice.undo(editor); }} className="cursor-pointer underline underline-offset-2">
      {t(notice.undoPending ? 'common.actions.retry' : 'skills.diff.undo')}
    </button>
  </div>;
}
