'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { tiptapJsonToMarkdown } from '@prismical/editor-markdown';
import type { Editor } from '@tiptap/react';
import { useSkillsList } from '@prismical/app-client';
import { useCurrentNote } from '../shell/current-note-context';
import { useCurrentNoteEditor } from '../shell/current-editor-context';
import { useRunSkill, useRecoverSkillResult } from '@prismical/app-client';
import { useSkillDiffStore } from '@prismical/app-client';
import { useAutoEnhanceStore, useSessionView, usePorts, activeOrgIdOf, useWorkflowSnapshot } from '@prismical/app-client';
import { useInlineRunStore } from '@prismical/app-client';
import { useAskSkillRunStore } from '@prismical/app-client';
import { SkillDiffDockBar, SkillDiffPendingBar } from './skill-diff-dock-bar';
import { ENHANCE_SKILL_ID } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';
import { skillDisplayName } from '../lib/skill-presentation';
import { SkillProposalHost } from './skill-proposal-host';

/** Live editor body as markdown, or undefined when it can't serialize (the run then degrades to
 * the server snapshot instead of dying before it starts). */
function safeMarkdown(editor: Editor): string | undefined {
  try {
    return tiptapJsonToMarkdown(editor.getJSON());
  } catch (err) {
    console.warn('live markdown serialization failed; falling back to server snapshot', err);
    return undefined;
  }
}

/**
 * The dock's skill slot keeps the workflow's original note selected across navigation. Queued
 * runs prepare a private editor before starting, and review uses that same editor through apply
 * and delivery. The visible note's editor is only a source of fresh local input; another note's
 * editor is never borrowed. Platforms without workflow ownership retain the current-note path.
 */
export function SkillDockSlot({ compact = false }: { compact?: boolean } = {}) {
  const currentNoteId = useCurrentNote().currentNote?.noteId ?? null;
  const session = useSessionView();
  const { workflow } = usePorts();
  const state = useWorkflowSnapshot();
  const askRequest = useAskSkillRunStore(s => s.request);
  const inlineRequest = useInlineRunStore(s => s.request);
  const ownerKey = session.activeSessionKey ?? session.activeSub;
  const ownerOrgId = activeOrgIdOf(session);
  const autoRequest = useAutoEnhanceStore(s => s.requests.find(request =>
    request.ownerSessionKey === ownerKey && request.ownerOrgId === ownerOrgId));
  const pendingNoteId = askRequest?.noteId ?? inlineRequest?.noteId ?? autoRequest?.noteId;
  const noteId = state.kind === 'skill' ? state.noteId
    : workflow && pendingNoteId ? pendingNoteId : currentNoteId;
  const needsHost = !!workflow && (state.kind === 'skill' || !!pendingNoteId);
  const hostKey = `${ownerKey}:${ownerOrgId}:${noteId}`;
  const [hostEditor, setHostEditor] = React.useState<{ key: string; editor: Editor } | null>(null);
  const receiveHostEditor = React.useCallback((key: string, editor: Editor | null) => {
    setHostEditor(current => editor ? { key, editor } : current?.key === key ? null : current);
  }, []);
  const { editor, editorNoteId } = useCurrentNoteEditor();
  const candidate = useSkillDiffStore(s => (noteId ? s.candidatesByNote.get(noteId) : undefined));

  // A staged candidate invalidates any parked inline request for this note: the bridge would
  // otherwise run it right after accept/reject, staging a surprise diff.
  const clearInlineRequest = useInlineRunStore(s => s.clear);
  React.useEffect(() => {
    if (candidate && inlineRequest && inlineRequest.noteId === noteId) clearInlineRequest();
  }, [candidate, inlineRequest, noteId, clearInlineRequest]);

  // Only drive the editor that belongs to THIS note. The current-note and current-editor
  // registrations update on different schedules (the editor registers only after its Y.Doc syncs),
  // so on a fast note switch the dock could otherwise hold the previous note's editor while noteId /
  // candidate already point at the new note — applying a run into the wrong document.
  const visibleEditorForNote = editor && editorNoteId === noteId ? editor : null;
  const editorForNote = needsHost
    ? hostEditor?.key === hostKey ? hostEditor.editor : null
    : visibleEditorForNote;

  if (!noteId) return null;
  return (
    <>
      <SkillRunBridge
        key={`bridge:${hostKey}`}
        noteId={noteId}
        editor={editorForNote}
      />
      {/* A staged candidate is ALWAYS represented. Without its editor there is nothing to review
          against yet, so the holding face stands in rather than the slot going empty - the
          suggestion is still in the store, and silence here reads as the work being thrown away. */}
      {needsHost ? (
        <SkillProposalHost key={`proposal:${hostKey}`} hostKey={hostKey} noteId={noteId} compact={compact}
          onEditor={receiveHostEditor} sourceEditor={visibleEditorForNote} />
      ) : candidate ? (
        editorForNote ? (
          <SkillDiffDockBar editor={editorForNote} noteId={noteId} compact={compact} />
        ) : (
          <SkillDiffPendingBar noteId={noteId} skillName={candidate.skillName} compact={compact} />
        )
      ) : null}
    </>
  );
}

/**
 * Headless run engine for the bridged lanes. Each lane parks a request in its store; this consumes
 * it exactly once and runs it through ONE `useRunSkill` instance per note, which publishes to the
 * run feed (Ask thread + pill) and stages the diff through the same pipeline as a refine. Renders
 * nothing.
 */
function SkillRunBridge({
  noteId,
  editor,
}: {
  noteId: string;
  editor: ReturnType<typeof useCurrentNoteEditor>['editor'];
}) {
  const { t } = useTranslation();
  const { data: allSkills = [], isPending: skillsPending, isError: skillsFailed } = useSkillsList();
  const { workflow } = usePorts();
  const { run } = useRunSkill(noteId, editor);
  useRecoverSkillResult(noteId, editor);

  // Auto-enhance-on-Stop + the transcript wand: run Enhance scoped to that recording.
  // We send the live editor markdown (the freshest body) to dodge the debounced-snapshot staleness.
  const session = useSessionView();
  const ownerSessionKey = session.activeSessionKey ?? session.activeSub;
  const ownerOrgId = activeOrgIdOf(session);
  const autoRequest = useAutoEnhanceStore(s =>
    s.requests.find(
      request =>
        request.noteId === noteId &&
        request.ownerSessionKey === ownerSessionKey &&
        request.ownerOrgId === ownerOrgId
    )
  );
  const consumeAutoRequest = useAutoEnhanceStore(s => s.consume);
  const hasCandidate = useSkillDiffStore(s => s.candidatesByNote.has(noteId));
  const runningRequestRef = React.useRef<string | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (!autoRequest || autoRequest.noteId !== noteId) return;
    // Wait until the editor is registered and the skills list has loaded before consuming — else a
    // brief mount/fetch gap would drop the request. Both settle in deps, so the effect re-fires.
    if (skillsPending || hasCandidate || runningRequestRef.current) return;
    const enhance = allSkills.find(s => s.id === ENHANCE_SKILL_ID && s.enabled);
    if (!enhance || skillsFailed) {
      const current = workflow?.getSnapshot();
      if (current?.kind === 'skill' && current.workflowId === autoRequest.workflowId) {
        workflow?.dispatch({ type: 'skillFailed', workflowId: current.workflowId, attempt: current.attempt });
      }
      toast.error(t('skills.dock.enhanceUnavailable'));
      consumeAutoRequest(autoRequest.recordingId);
      return;
    }
    if (!editor) return;
    // Send the live body to dodge snapshot staleness, but omit it above the server cap (1MB) so a
    // huge note degrades to the server snapshot instead of 400ing the whole auto-enhance. A
    // serialization failure (an unmapped future mark) degrades the same way instead of crashing
    // the auto-enhance effect (launch-readiness item 5, C2).
    const md = workflow ? undefined : safeMarkdown(editor);
    runningRequestRef.current = autoRequest.recordingId;
    void run({
      skillId: enhance.id,
      skillName: skillDisplayName(enhance, t),
      recordingId: autoRequest.recordingId,
      workflowId: autoRequest.workflowId,
      noteMarkdown: md !== undefined && md.length <= 1_000_000 ? md : undefined,
      source: autoRequest.source,
      requestedAt: autoRequest.requestedAt,
      attemptId: autoRequest.attemptId,
    }).finally(() => {
      runningRequestRef.current = null;
      if (mountedRef.current) consumeAutoRequest(autoRequest.recordingId);
    });
  }, [autoRequest, noteId, editor, allSkills, run, consumeAutoRequest, hasCandidate, t, workflow, skillsPending, skillsFailed]);

  // Ask composer `/skill` send + the Ask pill's one-click chip (dock v3). Extra typed guidance
  // rides as the run's instruction.
  const askRequest = useAskSkillRunStore(s => s.request);
  const clearAskRequest = useAskSkillRunStore(s => s.clear);
  React.useEffect(() => {
    if (!askRequest || askRequest.noteId !== noteId) return;
    if (!editor || allSkills.length === 0) return; // settles in deps; re-fires
    clearAskRequest();
    const skill = allSkills.find(s => s.id === askRequest.skillId && s.enabled);
    if (!skill) {
      toast.error(t('skills.dock.skillUnavailable'));
      return;
    }
    const md = workflow ? undefined : safeMarkdown(editor);
    void run({
      skillId: skill.id,
      skillName: askRequest.skillName || skillDisplayName(skill, t),
      // The Ask lanes filter title-target skills out, but the target still travels with the run
      // so the dirty-title guard and the feed exclusion hold if one ever gets through.
      outputTarget: skill.config.outputTarget,
      refineInstruction: askRequest.instruction,
      noteMarkdown: md !== undefined && md.length <= 1_000_000 ? md : undefined,
      source: askRequest.source,
      requestedAt: askRequest.requestedAt,
      attemptId: askRequest.attemptId,
    });
  }, [askRequest, noteId, editor, allSkills, run, clearAskRequest, t, workflow]);

  // Inline popover: the popover captures the selection and parks a request. No
  // skills-list wait: the request already carries the skill identity (the popover listed it).
  const inlineRequest = useInlineRunStore(s => s.request);
  const clearInlineRequest = useInlineRunStore(s => s.clear);
  React.useEffect(() => {
    if (!inlineRequest || inlineRequest.noteId !== noteId) return;
    if (!editor) return; // settles in deps; the effect re-fires once registered
    clearInlineRequest();
    void run({
      skillId: inlineRequest.skillId,
      requestedAt: inlineRequest.requestedAt,
      attemptId: inlineRequest.attemptId,
      skillName: inlineRequest.skillName,
      mode: 'inline-rewrite',
      selectionText: inlineRequest.selectionText,
      selectionAnchors: inlineRequest.selectionAnchors,
      noteMarkdown: inlineRequest.noteMarkdown,
      source: 'inline',
    });
  }, [inlineRequest, noteId, editor, run, clearInlineRequest]);

  return null;
}
