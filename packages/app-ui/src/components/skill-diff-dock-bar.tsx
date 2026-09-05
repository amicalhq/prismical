'use client';

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
import { useRunSkill, useSkillRunActivityStore } from '@prismical/app-client';
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
  /** Narrow-surface mode (the floating note window): the pill takes the full
   * window width with a flexible input, so Keep/Undo never clip off-screen. */
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

  const onAccept = async () => {
    // Inline-rewrite: verify the target still exists BEFORE persisting the artifact, so a vanished
    // selection (deleted by a collaborator while staged) costs nothing server-side.
    if (candidate.mode === 'inline-rewrite' && !resolveInlineRange()) {
      toast.error(t('skills.diff.targetMissing'));
      clearDiffDecorations(editor);
      clear(noteId);
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
      console.warn('skill accept: save failed', err);
      toast.error(t('skills.diff.couldNotSave', { name: candidate.skillName }));
      clearDiffDecorations(editor);
      return;
    }

    // Release the editor lock BEFORE dispatching the accept's command (the lock filters mutating
    // txns while a candidate is staged; clearing first lets insertArtifactBlock / setContent land).
    clear(noteId);
    // The Ask thread's run turn flips from "Drafted…" to "Kept" (dock v3 run feed).
    useSkillRunActivityStore.getState().resolveStaged(noteId, 'kept');

    if (candidate.mode === 'append-section') {
      editor.commands.insertArtifactBlock({
        artifactId: meta.artifactId,
        skillId: candidate.skillId,
        skillName: candidate.skillName,
        version: meta.version,
        generatedAt: meta.generatedAt,
        modelId: candidate.modelId,
        content: candidate.content,
      });
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        editor.view.dom.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      // Undo only when THIS accept snapshotted — otherwise restore would revert to an older accept.
      toast.success(t('skills.diff.newSectionAdded'), acceptToastOpts);
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
        // the await — rare). Tombstone the just-written row so it can't confuse restore-last;
        // best-effort, and we deliberately ignore its prevContent (nothing was applied).
        void restoreLastSkillRun(noteId).catch(() => {});
        toast.error(t('skills.diff.targetMissing'));
      }
    } else {
      // setContent replaces the whole doc — guard against an invalid-content throw (parity with the
      // append path's fail-quiet) so a bad candidate can't crash the editor.
      try {
        editor.commands.setContent({ type: 'doc', content: candidate.content });
        requestAnimationFrame(() => {
          if (editor.isDestroyed) return;
          editor.view.dom.firstElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        // Replace-doc is the destructive case Undo exists for — offer it whenever we snapshotted.
        toast.success(t('skills.diff.noteReplaced'), acceptToastOpts);
      } catch (err) {
        console.warn('setContent (replace-doc) failed', err);
        toast.error(t('skills.diff.couldNotApply', { name: candidate.skillName }));
      }
    }
    clearDiffDecorations(editor);
    refreshFolded(); // an Enhance accept just folded a recording in
  };

  const reject = () => {
    clearDiffDecorations(editor);
    clear(noteId);
    useSkillRunActivityStore.getState().resolveStaged(noteId, 'undone');
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
    <div className={`${PILL_OUTER} ${compact ? 'w-[calc(100vw-20px)]' : ''}`}>
      {/* The skill identity tag — slash badge + name, field-toned like a token. */}
      <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-dock-field pl-1 pr-2 text-[12.5px] font-semibold text-dock-ink">
        <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-dock-surface text-[11px] font-semibold text-dock-ink-2">
          /
        </span>
        <span className="max-w-[120px] truncate">{candidate.skillName}</span>
      </span>

      {/* The refine input is always live (no separate mode) — it widens on focus. */}
      {refining ? (
        // The Ask unit is collapsed while a candidate is staged, so this is the refine's only
        // reachable Stop.
        <span className="flex items-center gap-1">
          <span className="shimmer shimmer-duration-1400 text-dock-ink-3 whitespace-nowrap px-2 text-[12.5px]">
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
            <TooltipContent>{t('skills.dock.stopRun')}</TooltipContent>
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
          className={
            compact
              ? 'h-7 min-w-0 flex-1 bg-transparent px-2 text-[12.5px] text-dock-ink outline-none placeholder:text-dock-ink-3'
              : 'h-7 w-[150px] bg-transparent px-2 text-[12.5px] text-dock-ink outline-none transition-[width] duration-200 placeholder:text-dock-ink-3 focus:w-[230px]'
          }
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
          <TooltipContent>{t('skills.diff.submitRefinement')}</TooltipContent>
        </Tooltip>
      ) : null}

      {/* Undo = discard the suggestion (the note never changed); Keep = accept. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={reject} disabled={accept.isPending} className={REVIEW_BTN}>
            <Undo2 className="size-3.5" />
            {t('skills.diff.undo')}
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('skills.diff.reject')}</TooltipContent>
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
        <TooltipContent>{t('skills.diff.acceptChanges')}</TooltipContent>
      </Tooltip>
    </div>
  );
}
