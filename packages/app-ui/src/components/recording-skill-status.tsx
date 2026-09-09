'use client';

import { useSkillRuns } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';
import { SkillRunStatus } from './ask/ask-skill-run-turn';

/** Share the same run and abort handle as Ask; opening a panel never starts a run. */
export function RecordingSkillStatus({
  noteId,
  onReviewInNote,
  children,
  hideCompleted = false,
}: {
  children?: React.ReactNode;
  hideCompleted?: boolean;
  noteId: string;
  onReviewInNote: () => void;
}) {
  const { t } = useTranslation();
  const runs = useSkillRuns(noteId);
  const run = [...runs].reverse().find(item => item.status === 'running') ?? runs.at(-1);
  const actionable = run && ['running', 'staged', 'error'].includes(run.status);
  if (!actionable || (hideCompleted && run.status !== 'running')) return children ?? null;
  return (
    <div
      className="min-w-0 px-1 [&_[data-slot=marker]]:text-xs"
      data-recording-skill-status={run.status}
    >
      <SkillRunStatus compact run={run} onReviewInNote={onReviewInNote} t={t} />
    </div>
  );
}
