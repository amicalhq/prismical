'use client';

import * as React from 'react';
import { Check, CircleSlash, Info, RefreshCw, TriangleAlert, Undo2 } from 'lucide-react';
import { STATUS_LINK } from './ask-skill-run-turn-styles';
import type { SkillRunRecord } from '@prismical/app-client';
import { Bubble, BubbleContent } from '../../ui/bubble';
import { Marker, MarkerContent, MarkerIcon } from '../../ui/marker';
import { Message, MessageContent } from '../../ui/message';
import { Loader } from '../ai-elements/loader';
import { useTranslation } from 'react-i18next';

/**
 * One skill run rendered as a turn in the Ask thread (dock v3, skills-in-Ask): the user bubble
 * carries the slash token + any typed guidance — a run reads as something you said — and the
 * assistant side is a status marker that follows the run from "Running Cleanup…" to its terminal
 * state (Drafted a suggestion → Kept / Undone; or Stopped / a friendly skip / an error).
 *
 * The mock's step checkmarks ("Read the transcript", "Drafted…") are deliberately absent: the run
 * endpoint is one POST with no progress stream, so any steps would be invented. Keep / Undo stay
 * on the review pill (one source of truth); "Review in note" just hands the user to it.
 *
 * Ephemeral: the record lives in the client run feed; persisting it as a conversation turn is
 * follow-up work.
 */
export function AskSkillRunTurn({
  run,
  onReviewInNote,
}: {
  run: SkillRunRecord;
  /** Collapse the panel so the staged diff + review pill are in view. */
  onReviewInNote?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-[18px]" data-skill-run={run.status} data-onboarding="skill-status">
      <Message align="end">
        <MessageContent>
          <Bubble align="end">
            <BubbleContent>
              <span className="font-semibold">/{run.skillName}</span>
              {run.instruction ? ` ${run.instruction}` : ''}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <SkillRunStatus run={run} onReviewInNote={onReviewInNote} t={t} />
    </div>
  );
}

export function SkillRunStatus({
  run,
  onReviewInNote,
  t,
  compact = false,
}: {
  run: Pick<SkillRunRecord, 'skillName' | 'status' | 'phase' | 'detail' | 'body' | 'actions' | 'cancel'>;
  onReviewInNote?: () => void;
  t: ReturnType<typeof useTranslation>['t'];
  compact?: boolean;
}) {
  const name = run.skillName;
  if (compact) {
    const running = run.status === 'running';
    const ready = run.status === 'staged';
    const failed = run.status === 'error';
    const stopped = run.status === 'stopped';
    const action = run.actions?.find(item => item.kind === 'retry') ?? run.actions?.[0];
    const detail = running
      ? run.phase === 'waiting-transcript'
        ? `${name} · ${t('recording.panel.waitingForTranscription')}`
        : t('ask.skillRun.running', { name })
      : (run.detail ?? (ready ? t('ask.skillRun.staged', { name }) : `${name} · ${run.status}`));
    return (
      <div
        role="status"
        data-onboarding="skill-status"
        title={detail}
        aria-label={detail}
        className="flex h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-dock-line px-2 text-xs text-dock-ink-2"
      >
        <span className="shrink-0" aria-hidden="true">
          {running ? (
            <Loader size={13} />
          ) : failed ? (
            <TriangleAlert className="size-3.5 text-destructive" />
          ) : run.status === 'skipped' ? (
            <Info className="size-3.5" />
          ) : stopped || run.status === 'undone' ? (
            <CircleSlash className="size-3.5" />
          ) : (
            <Check className="size-3.5 text-success" />
          )}
        </span>
        <span className="min-w-0 max-w-[80px] truncate">{name}</span>
        {running && run.cancel ? (
          <button
            type="button"
            onClick={run.cancel}
            aria-label={t('ask.skillRun.stop', { name })}
            className={`${STATUS_LINK} shrink-0`}
          >
            {t('ask.composer.stop')}
          </button>
        ) : ready && onReviewInNote ? (
          <button
            type="button"
            onClick={onReviewInNote}
            aria-label={t('ask.skillRun.reviewInNote')}
            className={`${STATUS_LINK} shrink-0`}
          >
            {t('ask.skillRun.review')}
          </button>
        ) : action ? (
          <button
            type="button"
            onClick={action.onClick}
            className={`${STATUS_LINK} max-w-[90px] truncate`}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    );
  }
  switch (run.status) {
    case 'running':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <Loader size={14} />
          </MarkerIcon>
          <MarkerContent>
            <span className="shimmer shimmer-duration-1400">
              {run.phase === 'waiting-transcript'
                ? `${name} · ${t('recording.panel.waitingForTranscription')}`
                : t('ask.skillRun.running', { name })}
            </span>
            {/* Every run can be stopped from its turn — including lanes the composer does not
                own (wand, auto-enhance, inline, refine). */}
            {run.cancel ? (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={run.cancel}
                  aria-label={t('ask.skillRun.stop', { name })}
                  className={STATUS_LINK}
                >
                  {t('ask.composer.stop')}
                </button>
              </>
            ) : null}
          </MarkerContent>
        </Marker>
      );
    case 'applied':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <Check className="size-[14px] text-success" />
          </MarkerIcon>
          <MarkerContent>{t('ask.skillRun.applied', { name })}</MarkerContent>
        </Marker>
      );
    case 'staged':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <Check className="size-[14px] text-success" />
          </MarkerIcon>
          <MarkerContent>
            {t('ask.skillRun.staged', { name })}
            {onReviewInNote ? (
              <>
                {' · '}
                <button type="button" onClick={onReviewInNote} className={STATUS_LINK}>
                  {t('ask.skillRun.reviewInNote')}
                </button>
              </>
            ) : null}
          </MarkerContent>
        </Marker>
      );
    case 'kept':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <Check className="size-[14px] text-success" />
          </MarkerIcon>
          <MarkerContent>{t('ask.skillRun.kept', { name })}</MarkerContent>
        </Marker>
      );
    case 'undone':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <Undo2 className="size-[14px]" />
          </MarkerIcon>
          <MarkerContent>{t('ask.skillRun.undone', { name })}</MarkerContent>
        </Marker>
      );
    case 'superseded':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <RefreshCw className="size-[14px]" />
          </MarkerIcon>
          <MarkerContent>{t('ask.skillRun.superseded')}</MarkerContent>
        </Marker>
      );
    case 'stopped':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <CircleSlash className="size-[14px]" />
          </MarkerIcon>
          <MarkerContent>{t('ask.skillRun.stopped')}</MarkerContent>
        </Marker>
      );
    case 'skipped':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <Info className="size-[14px]" />
          </MarkerIcon>
          <MarkerContent>
            {run.detail ?? t('ask.skillRun.skipped', { name })}
            <Followup run={run} />
          </MarkerContent>
        </Marker>
      );
    case 'error':
      return (
        <Marker className="w-fit" role="status">
          <MarkerIcon>
            <TriangleAlert className="size-[14px] text-destructive" />
          </MarkerIcon>
          <MarkerContent className="text-destructive">
            {run.detail ?? t('ask.skillRun.failed', { name })}
            <Followup run={run} />
          </MarkerContent>
        </Marker>
      );
  }
}

/**
 * The second line + recovery actions of a terminal run (the server's `user.body` and its chosen
 * actions, bound by the client): "Update it in Settings, or use Prismical Cloud for now. ·
 * Open AI models · Use Prismical Cloud".
 */
function Followup({ run }: { run: Pick<SkillRunRecord, 'body' | 'actions'> }) {
  const actions = run.actions ?? [];
  if (!run.body && actions.length === 0) return null;
  return (
    <span className="block text-dock-ink-3">
      {run.body}
      {actions.map(a => (
        <React.Fragment key={a.kind}>
          {' · '}
          <button type="button" onClick={a.onClick} className={STATUS_LINK}>
            {a.label}
          </button>
        </React.Fragment>
      ))}
    </span>
  );
}
