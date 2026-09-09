'use client';
import { apiClient, ME_PREFIX, usePorts, useWorkflowSnapshot, resolvePendingSkillResult, type SkillDiffCandidate } from '@prismical/app-client';
import { useWalkthroughEvent } from '../onboarding/context';

import * as React from 'react';
import { ArrowUp, Check, Undo2, X } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useSkillDiffStore } from '@prismical/app-client';
import { clearDiffDecorations } from '@prismical/app-client';
import { resolveVerifiedRange } from '@prismical/app-client';
import { useAcceptArtifact, restoreLastSkillRun } from '@prismical/app-client';
import { enhancedRecordingsKey } from '@prismical/app-client';
import { useRunSkill, useSkillRunActivityStore, useAutoEnhanceStore } from '@prismical/app-client';
import { DOCK_CTL_PRIMARY, DOCK_PILL_CHROME } from './dock-chrome';
import { useTranslation } from 'react-i18next';

const PILL_OUTER = `${DOCK_PILL_CHROME} gap-1 px-1.5`;

// Keep the restore snapshot under the server cap (types.ts prevContent max); above it we omit the
// snapshot and skip the Undo affordance rather than 400 the accept.
const PREV_CONTENT_MAX = 2_000_000;

const REVIEW_BTN =
  'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink active:scale-95 disabled:cursor-not-allowed disabled:opacity-60';

function discardWorkflowProposal(candidate: SkillDiffCandidate, message: string, retryLabel: string, onDeleted: () => void) {
  const artifactId = candidate.acceptance?.result.artifactId;
  if (!candidate.resultId && !artifactId) return;
  const remove = async () => {
    try {
      if (candidate.resultId) await resolvePendingSkillResult(candidate.noteId, candidate.resultId, { discardAccepted: true });
      else await apiClient.del(`${ME_PREFIX}/artifacts/${encodeURIComponent(artifactId!)}`);
      onDeleted();
    } catch {
      toast.error(message, { action: { label: retryLabel, onClick: () => void remove() } });
    }
  };
  void remove();
}

/** An applied body cannot be discarded as a suggestion. Retiring its host is an explicit exit. */
function SkillDeliveryRecovery({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const { workflow } = usePorts();
  const state = useWorkflowSnapshot();
  const candidate = useSkillDiffStore(s => s.candidatesByNote.get(noteId));
  if (!candidate?.acceptance?.applied || !workflow || state.kind !== 'skill' ||
      state.phase !== 'review' || state.workflowId !== candidate.workflowId) return null;
  const end = () => {
    const current = workflow.getSnapshot();
    const proposal = useSkillDiffStore.getState().getCandidate(noteId);
    if (current.kind !== 'skill' || current.phase !== 'review' ||
        current.workflowId !== candidate.workflowId || current.proposalId !== candidate.proposalId ||
        proposal?.proposalId !== candidate.proposalId || !proposal?.acceptance?.applied) return;
    useSkillDiffStore.getState().clear(noteId);
    useSkillRunActivityStore.getState().resolveStaged(noteId, 'error', t('skills.diff.deliveryPending'));
    workflow.dispatch({ type: 'skillHostClosed', workflowId: current.workflowId, attempt: current.attempt });
  };
  return <div role="status" className="flex max-w-full flex-wrap items-center justify-center gap-x-2 px-3 text-xs text-dock-ink-3">
    <span>{t('skills.diff.deliveryPending')} {t('skills.diff.endWorkflowWarning')}</span>
    <button type="button" onClick={end} className={REVIEW_BTN}>{t('workflow.end')}</button>
  </div>;
}

interface Props {
  editor: Editor;
  noteId: string;
  /** A temporary document host must finish sending edits before the workflow releases it. */
  beforeApplyComplete?: () => Promise<void>;
  canApply?: () => boolean;
  /** The visible original-note editor can support the existing post-Keep Undo toast. */
  restoreEditor?: Editor | null;
  /** Use two review rows in the floating note window, reserving room for the
   * recording control. The web layout also adapts to the available pane width. */
  compact?: boolean;
}

/**
 * The review pill: shown in place of the sparkle button while a skill
 * candidate is staged for `noteId` — [/Skill tag] [Describe edits…] [↩ Undo]
 * [✓ Keep], with the refine input always live (typing + Enter re-runs with the
 * instruction). Same staged-diff engine underneath: Keep persists the artifact
 * and applies it to the Yjs-backed editor; Undo discards the suggestion.
 * Inline-rewrite accepts resolve the target range from Yjs relative anchors.
 */
export function SkillDiffDockBar({ editor, noteId, compact = false, beforeApplyComplete, canApply, restoreEditor }: Props) {
  const { t } = useTranslation();
  const walkthroughEvent = useWalkthroughEvent();
  const { workflow } = usePorts();
  const workflowState = useWorkflowSnapshot();
  const applying = workflowState.kind === 'skill' && workflowState.phase === 'applying';
  const candidate = useSkillDiffStore(s => s.candidatesByNote.get(noteId));
  const refineBlocked = applying || !!candidate?.acceptance;
  const clear = useSkillDiffStore(s => s.clear);
  const accept = useAcceptArtifact();
  const qc = useQueryClient();
  const { run, cancel, running: refining } = useRunSkill(noteId, editor);

  // An accept/restore changes which recordings are folded — refresh the picker's wand/"in note" state.
  const refreshFolded = () =>
    void qc.invalidateQueries({ queryKey: enhancedRecordingsKey(noteId) });

  const [refineText, setRefineText] = React.useState('');

  if (!candidate) return null;

  // Roll the note body back to before the last accepted run. Apply the pre-accept SNAPSHOT the accept
  // captured (passed in) FIRST, THEN ask the server to soft-delete the artifact — never the reverse.
  // The old order (server-delete, then client-apply) could tombstone the artifact while the body still
  // held the accepted content if the client navigated away or the response was lost mid-request: the
  // recording would un-fold, its wand reappear, and clicking it would DUPLICATE the section (with a
  // second undo then over-reverting). The safety floor for a destructive replace-doc accept.
  const restoreLast = async (snapshot: string, artifactId: string) => {
    const undoEditor = beforeApplyComplete ? restoreEditor : editor;
    if (!undoEditor || undoEditor.isDestroyed) {
      toast.info(t('skills.diff.reopenUndo'));
      return;
    }
    const undo = workflow?.dispatch({ type: 'runSkill', workflowId: crypto.randomUUID(), noteId, skillId: candidate.skillId });
    if (undo && !undo.accepted) {
      toast.info(t('workflow.busy', { defaultValue: 'Finish the current recording or skill first.' }));
      return;
    }
    try {
    // 1) Revert the body from the snapshot first. If parsing/applying throws, bail BEFORE any server
    //    call — we must never soft-delete the artifact when we couldn't put the body back.
    try {
      const restored = undoEditor.commands.setContent(JSON.parse(snapshot));
      if (workflow && !restored) throw new Error('The note editor refused the restore.');
    } catch (err) {
      // The parser/editor exception text is for the console, never the toast.
      console.warn('skill undo: could not re-apply the snapshot', err);
      toast.error(t('skills.diff.couldNotUndo'));
      return;
    }
    // 2) Now drop the artifact server-side so folded-detection un-folds the recording + the mode bias
    //    resets. The body is already reverted, so a failure here is a sync gap (surface + reconcile the
    //    picker), not a half-apply.
    try {
      if (workflow) await apiClient.del(`${ME_PREFIX}/artifacts/${encodeURIComponent(artifactId)}`);
      else await restoreLastSkillRun(noteId);
    } catch (err) {
      refreshFolded();
      console.warn('skill undo: restore sync failed', err);
      toast.error(t('skills.diff.restoredLocallySyncFailed'));
      return;
    }
    refreshFolded(); // the restored (soft-deleted) Enhance un-folds its recording
    toast.success(t('skills.diff.restoredPrevious'));
    } finally {
      if (undo?.state.kind === 'skill') workflow?.dispatch({ type: 'skillNoChange', workflowId: undo.state.workflowId, attempt: undo.state.attempt });
    }
  };

  // The inline target range is anchored with Yjs relative positions; resolving them against the
  // live doc is how we know where (and whether) the selected text still exists.
  // Verified: only a range that still spells the captured selection text is applied.
  const resolveInlineRange = () => {
    if (!candidate?.selectionAnchors) return null;
    return resolveVerifiedRange(
      editor.state,
      candidate.selectionAnchors,
      candidate.selectionText ?? ''
    );
  };

  // A staged run that ends without being applied must SAY so everywhere it was offered. Dropping
  // the candidate alone strips the Ask turn (it just disappears) and the recording view's Enhance
  // chip (its post-stop bar is on a short timer), leaving no way to retry the run that failed.
  const reportAcceptFailed = (detail: string) => {
    useSkillRunActivityStore.getState().resolveStaged(noteId, 'error', detail);
    if (candidate.recordingId) useAutoEnhanceStore.getState().markFailed(candidate.recordingId);
  };

  // Workflow retries retain their exact saved artifact; Decline retires it by ID.
  // Keep the existing restore behavior for clients without workflow ownership.
  const reportUnapplied = async (): Promise<string> => {
    if (!workflow) await restoreLastSkillRun(noteId).catch(err => {
      console.warn('skill accept: could not retire the unapplied artifact row', err);
    });
    const detail = t('skills.diff.couldNotApply', { name: candidate.skillName });
    toast.error(detail);
    return detail;
  };

  const onAccept = async () => {
    const admission = workflow?.dispatch({
      type: 'acceptProposal', workflowId: candidate.workflowId ?? '', proposalId: candidate.proposalId ?? '',
    });
    if (admission && (!admission.accepted || admission.state.kind !== 'skill')) return;
    const scope = admission?.state.kind === 'skill' ? admission.state : undefined;
    const isCurrentApply = () => {
      if (!workflow || !scope) return true;
      const current = workflow.getSnapshot();
      return current.kind === 'skill' && current.phase === 'applying' &&
        current.workflowId === scope.workflowId && current.attempt === scope.attempt &&
        current.proposalId === scope.proposalId;
    };
    let retryCandidate = candidate;
    let appliedSuccessfully = false;
    const successMessage = t(candidate.mode === 'append-section' ? 'skills.diff.newSectionAdded'
      : candidate.mode === 'inline-rewrite' ? 'skills.diff.selectionUpdated' : 'skills.diff.noteReplaced');
    const acceptToastOptions = (prevContent: string | undefined, artifactId: string) => ({
      id: `skill-accept-${noteId}`,
      ...(prevContent && (!beforeApplyComplete || (restoreEditor && !restoreEditor.isDestroyed))
        ? { action: { label: t('skills.diff.undo'), onClick: () => void restoreLast(prevContent, artifactId) } }
        : {}),
    });
    const reportKept = () => {
      if (candidate.recordingId)
        walkthroughEvent({ type: 'kept', noteId, recordingId: candidate.recordingId });
      useSkillRunActivityStore.getState().resolveStaged(noteId, 'kept');
    };
    try {
    // The body is already applied after a delivery timeout. Keep retries delivery, never insertion.
    if (canApply && !canApply()) throw new Error('The original note is not writable.');
    if (candidate.acceptance?.applied) {
      await beforeApplyComplete?.();
      if (!isCurrentApply()) return;
      clear(noteId);
      reportKept();
      clearDiffDecorations(editor);
      refreshFolded();
      appliedSuccessfully = true;
      toast.success(successMessage, acceptToastOptions(
        candidate.acceptance.prevContent, candidate.acceptance.result.artifactId));
      return;
    }
    // Inline-rewrite: verify the target still exists BEFORE persisting the artifact, so a vanished
    // selection (deleted by a collaborator while staged) costs nothing server-side. This is the one
    // place a candidate is discarded on purpose: the user is looking at a loaded document and the
    // text the rewrite targets is gone, so it can never apply.
    if (candidate.mode === 'inline-rewrite' && !resolveInlineRange()) {
      const detail = t('skills.diff.targetMissing');
      toast.error(detail);
      clearDiffDecorations(editor);
      if (!workflow) clear(noteId);
      reportAcceptFailed(detail);
      return;
    }

    // Snapshot the CURRENT doc (the candidate is a diff overlay, not yet applied) so the accept is
    // reversible. Omit above the cap; Undo is then unavailable rather than failing the accept.
    const snapshot = JSON.stringify(editor.getJSON());
    const targetChanged = (content: string) => !!workflow && candidate.mode === 'replace-doc' &&
      candidate.baseContent !== undefined && candidate.baseContent !== content;
    const reportTargetChanged = () => toast.info(t('workflow.noteChanged', {
      defaultValue: 'The note changed after this suggestion was generated. Decline it and run the skill again.',
    }));
    if (targetChanged(snapshot)) {
      reportTargetChanged();
      return;
    }
    const prevContent = candidate.acceptance
      ? candidate.acceptance.prevContent
      : snapshot.length <= PREV_CONTENT_MAX ? snapshot : undefined;

    let meta: { artifactId: string; version: number; generatedAt: string };
    try {
      meta = candidate.acceptance?.result ?? await accept.mutateAsync({
        resultId: candidate.resultId,
        noteId,
        skillId: candidate.skillId,
        recordingId: candidate.recordingId,
        mode: candidate.mode,
        content: JSON.stringify(candidate.content),
        rawMarkdown: candidate.rawMarkdown,
        prevContent,
        modelId: candidate.modelId,
        reasoning: candidate.reasoning,
        refineInstruction: candidate.refineInstruction,
        selectionText: candidate.selectionText,
        usage: candidate.usage,
      });
      retryCandidate = { ...candidate, acceptance: { result: meta, prevContent } };
    } catch (err) {
      // Keep the candidate AND its overlay: the save is retryable, and stripping the diff would
      // leave a review bar reviewing nothing (the decoration hook won't rebuild for the same key).
      if (!isCurrentApply()) return;
      walkthroughEvent({ type: 'error', noteId, code: 'accept_failed' });
      console.warn('skill accept: save failed', err);
      toast.error(t('skills.diff.couldNotSave', { name: candidate.skillName }));
      return;
    }

    if (!isCurrentApply()) return;
    if (editor.isDestroyed || (canApply && !canApply())) throw new Error('The note editor is no longer writable.');
    if (targetChanged(JSON.stringify(editor.getJSON()))) {
      reportTargetChanged();
      return;
    }

    const acceptToastOpts = acceptToastOptions(prevContent, meta.artifactId);

    // Release the editor lock BEFORE dispatching the accept's command (the lock filters mutating
    // txns while a candidate is staged; clearing first lets insertArtifactBlock / setContent land).
    clear(noteId);
    // How the Ask thread's run turn settles: "Drafted…" → "Kept", or an error the user can act on.
    // Resolved after the apply, not before, so a body write that never landed can't read as Kept.
    let failureDetail: string | null = null;

    if (candidate.mode === 'append-section') {
      // The command fails closed on a payload the schema can't materialize. Honour its answer:
      // reporting "Kept" for a body that was never written also folds the recording in, hiding the
      // wand and the Enhance chip for work that did not happen.
      const inserted = editor.commands.insertArtifactBlock({
        artifactId: meta.artifactId,
        skillId: candidate.skillId,
        skillName: candidate.skillName,
        version: meta.version,
        generatedAt: meta.generatedAt,
        modelId: candidate.modelId,
        content: candidate.content,
      });
      if (inserted) {
        requestAnimationFrame(() => {
          if (editor.isDestroyed) return;
          editor.view.dom.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        // Undo only when THIS accept snapshotted — otherwise restore would revert to an older accept.
      } else {
        failureDetail = await reportUnapplied();
      }
    } else if (candidate.mode === 'inline-rewrite') {
      // Re-resolve AFTER the await — a remote edit may have landed during the network call, and
      // the relative anchors re-resolve to wherever the target sits now.
      const range = resolveInlineRange();
      const applied =
        range !== null &&
        editor.commands.insertArtifactInline({
          artifactId: meta.artifactId,
          skillId: candidate.skillId,
          skillName: candidate.skillName,
          content: candidate.content,
          from: range.from,
          to: range.to,
        });
      if (!applied) {
        // The artifact row was persisted but the body wasn't touched (the target vanished during
        // the await — rare). Same shape as the other unapplied paths, but its own message: the
        // reason is the missing target, not a content fault.
        if (!workflow) await restoreLastSkillRun(noteId).catch(err => {
          console.warn('skill accept: could not retire the unapplied artifact row', err);
        });
        failureDetail = t('skills.diff.targetMissing');
        toast.error(failureDetail);
      }
    } else {
      // setContent replaces the whole doc — guard against an invalid-content throw (parity with the
      // append path's fail-quiet) so a bad candidate can't crash the editor.
      try {
        const applied = editor.commands.setContent({ type: 'doc', content: candidate.content });
        if (!applied) {
          failureDetail = await reportUnapplied();
        } else {
          requestAnimationFrame(() => {
            if (editor.isDestroyed) return;
            editor.view.dom.firstElementChild?.scrollIntoView({
              behavior: 'smooth',
              block: 'start',
            });
          });
          // Replace-doc is the destructive case Undo exists for — offer it whenever we snapshotted.
        }
      } catch (err) {
        console.warn('setContent (replace-doc) failed', err);
        failureDetail = await reportUnapplied();
      }
    }
    if (!isCurrentApply()) return;
    if (!failureDetail && beforeApplyComplete) {
      retryCandidate = { ...retryCandidate, acceptance: { ...retryCandidate.acceptance!, applied: true } };
      useSkillDiffStore.getState().stage(retryCandidate);
      await beforeApplyComplete();
      if (!isCurrentApply()) return;
      clear(noteId);
    }
    if (!failureDetail) toast.success(successMessage, acceptToastOpts);
    if (failureDetail) walkthroughEvent({ type: 'error', noteId, code: 'accept_failed' });
    if (failureDetail) reportAcceptFailed(failureDetail);
    else reportKept();
    appliedSuccessfully = !failureDetail;
    if (appliedSuccessfully) clearDiffDecorations(editor);
    refreshFolded(); // an Enhance accept just folded a recording in
    } catch (err) {
      if (!isCurrentApply()) return;
      console.warn('skill accept: apply failed', err);
      toast.error(retryCandidate.acceptance?.applied
        ? t('skills.diff.deliveryPending')
        : t('skills.diff.couldNotApply', { name: candidate.skillName }));
    } finally {
      if (workflow && scope && isCurrentApply()) {
        if (!appliedSuccessfully) useSkillDiffStore.getState().stage(retryCandidate);
        workflow.dispatch({
          type: appliedSuccessfully ? 'applySucceeded' : 'applyFailed',
          workflowId: scope.workflowId, attempt: scope.attempt,
        });
      }
    }
  };

  const reject = async () => {
    if (candidate.acceptance?.applied) return;
    if (workflow) {
      const result = workflow.dispatch({
        type: 'declineProposal', workflowId: candidate.workflowId ?? '', proposalId: candidate.proposalId ?? '',
      });
      if (!result.accepted) return;
      clearDiffDecorations(editor);
      clear(noteId);
      useSkillRunActivityStore.getState().resolveStaged(noteId, 'undone');
      discardWorkflowProposal(candidate, t('skills.diff.couldNotSave', { name: candidate.skillName }), t('common.actions.retry'), refreshFolded);
      if (candidate.recordingId) walkthroughEvent({ type: 'rejected', noteId, recordingId: candidate.recordingId });
      return;
    }
    if (candidate.resultId) {
      try {
        await resolvePendingSkillResult(noteId, candidate.resultId);
      } catch {
        toast.error(t('skills.diff.couldNotSave', { name: candidate.skillName }));
        return;
      }
    }
    clearDiffDecorations(editor);
    clear(noteId);
    useSkillRunActivityStore.getState().resolveStaged(noteId, 'undone');
    if (candidate.recordingId)
      walkthroughEvent({ type: 'rejected', noteId, recordingId: candidate.recordingId });
  };

  const submitRefine = () => {
    if (refineBlocked) return;
    const instruction = refineText.trim();
    if (!instruction) return;
    void run({
      skillId: candidate.skillId,
      proposalId: candidate.proposalId,
      skillName: candidate.skillName,
      mode: candidate.mode,
      recordingId: candidate.recordingId,
      // Inline-rewrite: the refined run keeps targeting the same range (anchors) and the same
      // original text (the model rewrites the ORIGINAL selection per the new instruction).
      selectionText: candidate.selectionText ?? undefined,
      selectionAnchors: candidate.selectionAnchors,
      refineInstruction: instruction,
      previousOutput: candidate.rawMarkdown,
      source: 'refine',
    });
    setRefineText('');
  };

  return (
    <>
    <SkillDeliveryRecovery noteId={noteId} />
    <div
      data-onboarding="review-controls"
      className={`skill-review-bar ${PILL_OUTER}`}
      data-compact={compact}
    >
      {/* The skill identity tag — slash badge + name, field-toned like a token. */}
      <span className="skill-review-identity flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-dock-field pl-1 pr-2 text-[12.5px] font-semibold text-dock-ink">
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-dock-surface text-[11px] font-semibold text-dock-ink-2">
          /
        </span>
        <span className="max-w-[120px] truncate">{candidate.skillName}</span>
      </span>

      <div className="skill-review-refinement flex min-w-0 items-center gap-1">
        {/* The refine input is always live (no separate mode) — it widens on focus. */}
        {refining ? (
          // The Ask unit is collapsed while a candidate is staged, so this is the refine's only
          // reachable Stop.
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="shimmer shimmer-duration-1400 min-w-0 truncate text-dock-ink-3 px-2 text-[12.5px]">
              {t('skills.diff.refining')}…
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={cancel}
                  aria-label={t('skills.dock.stopRun')}
                  className={`${REVIEW_BTN} w-7 justify-center px-0`}
                >
                  <X className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="pointer-events-none">
                {t('skills.dock.stopRun')}
              </TooltipContent>
            </Tooltip>
          </span>
        ) : (
          <input
            type="text"
            disabled={refineBlocked}
            placeholder={t('skills.diff.describeEdits')}
            value={refineText}
            onChange={e => setRefineText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submitRefine();
              if (e.key === 'Escape') setRefineText('');
            }}
            aria-label={t('skills.diff.refineInstruction')}
            className="h-7 min-w-0 bg-transparent px-2 text-[12.5px] text-dock-ink outline-none transition-[width] duration-200 placeholder:text-dock-ink-3"
          />
        )}
        {refineText.trim() && !refining ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={submitRefine}
                disabled={refineBlocked}
                className={DOCK_CTL_PRIMARY}
                aria-label={t('skills.diff.submitRefinement')}
              >
                <ArrowUp className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="pointer-events-none">
              {t('skills.diff.submitRefinement')}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* Undo = discard the suggestion (the note never changed); Keep = accept. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={reject} disabled={accept.isPending || refining || applying || candidate.acceptance?.applied} className={REVIEW_BTN}>
            <Undo2 className="size-3.5" />
            {t('skills.diff.undo')}
          </button>
        </TooltipTrigger>
        <TooltipContent className="pointer-events-none">{t('skills.diff.reject')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onAccept}
            disabled={accept.isPending || refining || applying}
            className={`${REVIEW_BTN} text-success hover:text-success`}
          >
            <Check className="size-3.5" />
            {t('skills.diff.keep')}
          </button>
        </TooltipTrigger>
        <TooltipContent className="pointer-events-none">
          {t('skills.diff.acceptChanges')}
        </TooltipContent>
      </Tooltip>
    </div>
    </>
  );
}

/**
 * The review pill's holding face: a candidate is staged for the note, but its editor has not
 * registered yet (the editor appears only once its Y.Doc syncs, so a slow or unreachable
 * collaboration service leaves it null). Rendering nothing here made a staged suggestion look
 * deleted while it was still safely in the store, which reads as data loss. Show it instead, and
 * swap to the real bar the moment the document arrives.
 */
export function SkillDiffPendingBar({
  noteId,
  skillName,
  compact = false,
}: {
  noteId: string;
  skillName: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { workflow } = usePorts();
  const state = useWorkflowSnapshot();
  const qc = useQueryClient();
  const clear = useSkillDiffStore(s => s.clear);
  const applied = useSkillDiffStore(s => s.candidatesByNote.get(noteId)?.acceptance?.applied === true);
  // Undo needs no editor, and it must be here: when the note fails to open outright the editor
  // never returns, and this bar is the only skill surface left (the Ask unit is collapsed while a
  // candidate is staged). Without it the dock would sit on "waiting" until a reload.
  const discard = async () => {
    const candidate = useSkillDiffStore.getState().getCandidate(noteId);
    if (candidate?.acceptance?.applied) return;
    if (!workflow && candidate?.resultId) {
      try {
        await resolvePendingSkillResult(noteId, candidate.resultId);
      } catch {
        toast.error(t('skills.diff.couldNotSave', { name: candidate.skillName }));
        return;
      }
      if (useSkillDiffStore.getState().getCandidate(noteId) !== candidate) return;
    }
    if (workflow && !workflow.dispatch({ type: 'declineProposal',
      workflowId: candidate?.workflowId ?? '', proposalId: candidate?.proposalId ?? '',
    }).accepted) return;
    clear(noteId);
    useSkillRunActivityStore.getState().resolveStaged(noteId, 'undone');
    if (workflow && candidate) {
      discardWorkflowProposal(candidate, t('skills.diff.couldNotSave', { name: candidate.skillName }), t('common.actions.retry'), () => {
        void qc.invalidateQueries({ queryKey: enhancedRecordingsKey(noteId) });
      });
    }
  };
  return (
    <>
    <SkillDeliveryRecovery noteId={noteId} />
    <div
      data-onboarding="review-controls"
      className={`skill-review-bar ${PILL_OUTER}`}
      data-compact={compact}
      role="status"
    >
      <span className="skill-review-identity flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-dock-field pl-1 pr-2 text-[12.5px] font-semibold text-dock-ink">
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-dock-surface text-[11px] font-semibold text-dock-ink-2">
          /
        </span>
        <span className="max-w-[120px] truncate">{skillName}</span>
      </span>
      <span className="shimmer shimmer-duration-1400 min-w-0 flex-1 truncate px-2 text-[12.5px] text-dock-ink-3">
        {t('skills.diff.waitingForDocument')}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={discard} disabled={applied || (!!workflow && (state.kind !== 'skill' || state.phase !== 'review'))} className={REVIEW_BTN}>
            <Undo2 className="size-3.5" />
            {t('skills.diff.undo')}
          </button>
        </TooltipTrigger>
        <TooltipContent className="pointer-events-none">{t('skills.diff.reject')}</TooltipContent>
      </Tooltip>
      <button type="button" disabled className={`${REVIEW_BTN} text-success`}>
        <Check className="size-3.5" />
        {t('skills.diff.keep')}
      </button>
    </div>
    </>
  );
}
