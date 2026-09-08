'use client';
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

interface Props {
  editor: Editor;
  noteId: string;
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
export function SkillDiffDockBar({ editor, noteId, compact = false }: Props) {
  const { t } = useTranslation();
  const walkthroughEvent = useWalkthroughEvent();
  const candidate = useSkillDiffStore(s => s.candidatesByNote.get(noteId));
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
  const restoreLast = async (snapshot: string) => {
    if (editor.isDestroyed) {
      toast.info(t('skills.diff.reopenUndo'));
      return;
    }
    // 1) Revert the body from the snapshot first. If parsing/applying throws, bail BEFORE any server
    //    call — we must never soft-delete the artifact when we couldn't put the body back.
    try {
      editor.commands.setContent(JSON.parse(snapshot));
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
      await restoreLastSkillRun(noteId);
    } catch (err) {
      refreshFolded();
      console.warn('skill undo: restore sync failed', err);
      toast.error(t('skills.diff.restoredLocallySyncFailed'));
      return;
    }
    refreshFolded(); // the restored (soft-deleted) Enhance un-folds its recording
    toast.success(t('skills.diff.restoredPrevious'));
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

  // The artifact row was written but the body was NOT. Retire the row so restore-last can't trip
  // over it and, crucially, so folded-detection stops reporting the recording as enhanced - that
  // flag is what hides the picker's wand for work that never landed.
  //
  // AWAITED, because `refreshFolded()` at the end of the accept refetches the folded set: fire this
  // and forget and the GET can be served before the soft-delete commits, leaving the picker showing
  // the recording as "in note" until some unrelated invalidation.
  //
  // Caveat: restore-last only retires a row that carries a pre-accept snapshot, and the client omits
  // that above PREV_CONTENT_MAX. On a very large note the row therefore survives and the recording
  // stays folded. Retiring by artifact id needs a server endpoint that doesn't exist yet.
  const tombstoneUnapplied = async (): Promise<string> => {
    await restoreLastSkillRun(noteId).catch(err => {
      console.warn('skill accept: could not retire the unapplied artifact row', err);
    });
    const detail = t('skills.diff.couldNotApply', { name: candidate.skillName });
    toast.error(detail);
    return detail;
  };

  const onAccept = async () => {
    // Inline-rewrite: verify the target still exists BEFORE persisting the artifact, so a vanished
    // selection (deleted by a collaborator while staged) costs nothing server-side. This is the one
    // place a candidate is discarded on purpose: the user is looking at a loaded document and the
    // text the rewrite targets is gone, so it can never apply.
    if (candidate.mode === 'inline-rewrite' && !resolveInlineRange()) {
      const detail = t('skills.diff.targetMissing');
      toast.error(detail);
      clearDiffDecorations(editor);
      clear(noteId);
      reportAcceptFailed(detail);
      return;
    }

    // Snapshot the CURRENT doc (the candidate is a diff overlay, not yet applied) so the accept is
    // reversible. Omit above the cap; Undo is then unavailable rather than failing the accept.
    const snapshot = JSON.stringify(editor.getJSON());
    const prevContent = snapshot.length <= PREV_CONTENT_MAX ? snapshot : undefined;

    // A stable per-note id so a follow-up accept REPLACES this toast — only the latest accept's Undo
    // is ever on screen, so "Undo" unambiguously means "undo the last accept".
    const acceptToastOpts = {
      id: `skill-accept-${noteId}`,
      // Undo re-applies THIS snapshot (apply-first, then server soft-delete), so it can't half-apply.
      // Only offered when we actually snapshotted (body was under the cap).
      ...(prevContent
        ? { action: { label: t('skills.diff.undo'), onClick: () => void restoreLast(prevContent) } }
        : {}),
    };

    let meta: { artifactId: string; version: number; generatedAt: string };
    try {
      meta = await accept.mutateAsync({
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
    } catch (err) {
      // Keep the candidate AND its overlay: the save is retryable, and stripping the diff would
      // leave a review bar reviewing nothing (the decoration hook won't rebuild for the same key).
      walkthroughEvent({ type: 'error', noteId, code: 'accept_failed' });
      console.warn('skill accept: save failed', err);
      toast.error(t('skills.diff.couldNotSave', { name: candidate.skillName }));
      return;
    }

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
        toast.success(t('skills.diff.newSectionAdded'), acceptToastOpts);
      } else {
        failureDetail = await tombstoneUnapplied();
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
      if (applied) {
        toast.success(t('skills.diff.selectionUpdated'), acceptToastOpts);
      } else {
        // The artifact row was persisted but the body wasn't touched (the target vanished during
        // the await — rare). Same shape as the other unapplied paths, but its own message: the
        // reason is the missing target, not a content fault.
        await restoreLastSkillRun(noteId).catch(err => {
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
          failureDetail = await tombstoneUnapplied();
        } else {
          requestAnimationFrame(() => {
            if (editor.isDestroyed) return;
            editor.view.dom.firstElementChild?.scrollIntoView({
              behavior: 'smooth',
              block: 'start',
            });
          });
          // Replace-doc is the destructive case Undo exists for — offer it whenever we snapshotted.
          toast.success(t('skills.diff.noteReplaced'), acceptToastOpts);
        }
      } catch (err) {
        console.warn('setContent (replace-doc) failed', err);
        failureDetail = await tombstoneUnapplied();
      }
    }
    if (failureDetail) walkthroughEvent({ type: 'error', noteId, code: 'accept_failed' });
    else if (candidate.recordingId)
      walkthroughEvent({ type: 'kept', noteId, recordingId: candidate.recordingId });
    if (failureDetail) reportAcceptFailed(failureDetail);
    else useSkillRunActivityStore.getState().resolveStaged(noteId, 'kept');
    clearDiffDecorations(editor);
    refreshFolded(); // an Enhance accept just folded a recording in
  };

  const reject = () => {
    clearDiffDecorations(editor);
    clear(noteId);
    useSkillRunActivityStore.getState().resolveStaged(noteId, 'undone');
    if (candidate.recordingId)
      walkthroughEvent({ type: 'rejected', noteId, recordingId: candidate.recordingId });
  };

  const submitRefine = () => {
    const instruction = refineText.trim();
    if (!instruction) return;
    void run({
      skillId: candidate.skillId,
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
          <button type="button" onClick={reject} disabled={accept.isPending} className={REVIEW_BTN}>
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
            disabled={accept.isPending || refining}
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
  const clear = useSkillDiffStore(s => s.clear);
  // Undo needs no editor, and it must be here: when the note fails to open outright the editor
  // never returns, and this bar is the only skill surface left (the Ask unit is collapsed while a
  // candidate is staged). Without it the dock would sit on "waiting" until a reload.
  const discard = () => {
    clear(noteId);
    useSkillRunActivityStore.getState().resolveStaged(noteId, 'undone');
  };
  return (
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
          <button type="button" onClick={discard} className={REVIEW_BTN}>
            <Undo2 className="size-3.5" />
            {t('skills.diff.undo')}
          </button>
        </TooltipTrigger>
        <TooltipContent className="pointer-events-none">{t('skills.diff.reject')}</TooltipContent>
      </Tooltip>
    </div>
  );
}
