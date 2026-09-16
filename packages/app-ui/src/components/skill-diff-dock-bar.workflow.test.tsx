// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import { createWorkflowRuntime, type WorkflowRuntime } from '@prismical/app-workflow';
import { useSkillDiffStore, type SkillDiffCandidate } from '../../../app-client/src/notes/diff/skill-diff-store';

const mocks = vi.hoisted(() => ({
  workflow: null as WorkflowRuntime | null,
  sessionKey: "session",
  walkthrough: vi.fn(),
  successToast: vi.fn(),
  undoAccepted: vi.fn(),
  resolveRun: vi.fn(),
  errorToast: vi.fn(),
  save: vi.fn(),
  apply: vi.fn(),
  resolveStaged: vi.fn(),
  restore: vi.fn(),
  resolvePending: vi.fn(),
  deleteArtifact: vi.fn(),
  getDocument: vi.fn(),
  run: vi.fn(),
  wasApplied: vi.fn(),
  prepare: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock('@prismical/app-client', async () => {
  const React = await import('react');
  const { useSkillDiffStore } = await import('../../../app-client/src/notes/diff/skill-diff-store');
  const { isGenuinelyEmptyNote } = await import('../../../app-client/src/notes/diff/skill-result-application');
  const { useNoteCreatedNotice } = await import('../../../app-client/src/notes/note-created-notice');
  const idle = { kind: 'idle' } as const;
  return {
    withEditorHistoryBoundary: (_editor: unknown, apply: () => unknown) => apply(),
    isGenuinelyEmptyNote, useNoteCreatedNotice,
    skillRunFeedback: () => ({ error: mocks.errorToast }),
    wasSkillResultApplied: mocks.wasApplied,
    prepareSkillResultUpdate: mocks.prepare,
    applyPreparedSkillResult: mocks.apply,
    waitForSkillResultDelivery: mocks.deliver,
    apiClient: { del: mocks.deleteArtifact },
    ME_PREFIX: '/apps/v1/me',
    activeOrgIdOf: () => "org",
    usePorts: () => ({ workflow: mocks.workflow, auth: { getSession: () => ({ activeSessionKey: mocks.sessionKey }) } }),
    useWorkflowSnapshot: () => React.useSyncExternalStore(mocks.workflow?.subscribe ?? (() => () => {}), mocks.workflow?.getSnapshot ?? (() => idle)),
    useSkillDiffStore,
    useAcceptArtifact: () => ({ mutateAsync: mocks.save, isPending: false }),
    useRunSkill: () => ({ run: mocks.run, cancel: vi.fn(), running: false }),
    useSkillRunActivityStore: { getState: () => ({ resolveStaged: mocks.resolveStaged, runsByNote: new Map(), undoAccepted: mocks.undoAccepted, resolveRun: mocks.resolveRun }) },
    useAutoEnhanceStore: { getState: () => ({ markFailed: vi.fn() }) },
    clearDiffDecorations: vi.fn(),
    resolveVerifiedRange: vi.fn(),
    restoreLastSkillRun: mocks.restore,
    resolvePendingSkillResult: mocks.resolvePending,
    enhancedRecordingsKey: () => [],
  };
});
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('../onboarding/context', () => ({ useWalkthroughEvent: () => mocks.walkthrough }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { useNoteCreatedNotice } = await import('../../../app-client/src/notes/note-created-notice');
vi.mock('sonner', () => ({ toast: { success: mocks.successToast, error: mocks.errorToast, info: vi.fn() } }));
vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}));

const { SkillDiffDockBar, SkillDiffPendingBar } = await import('./skill-diff-dock-bar');
const saved = { artifactId: 'artifact', version: 1, generatedAt: '2026-09-09T00:00:00Z' };
const candidate: SkillDiffCandidate = {
  workflowId: 'workflow', proposalId: 'proposal', resultId: 'result',
  noteId: 'note', skillId: 'cleanup', skillName: 'Cleanup',
  mode: 'append-section', modelId: 'model', reasoning: null,
  refineInstruction: null, selectionText: null, content: [], rawMarkdown: 'Clean text',
};

function runtime() {
  return mocks.workflow!;
}

function stageReview() {
  const state = runtime().dispatch({ type: 'runSkill', workflowId: 'workflow', noteId: 'note', skillId: 'cleanup' }).state;
  if (state.kind !== 'skill') throw new Error('Expected admitted skill');
  runtime().dispatch({ type: 'proposalReady', workflowId: state.workflowId, attempt: state.attempt, proposalId: 'proposal' });
  useSkillDiffStore.getState().stage(candidate);
}

function mount(props: Partial<React.ComponentProps<typeof SkillDiffDockBar>> = {}) {
  const editor = {
    isDestroyed: false,
    getJSON: mocks.getDocument,
    commands: { insertArtifactBlock: mocks.apply, setContent: mocks.apply },
    view: { dom: document.createElement('div') },
  } as unknown as Editor;
  return render(<SkillDiffDockBar editor={editor} noteId="note" {...props} />);
}

beforeEach(() => {
  mocks.workflow = createWorkflowRuntime();
  mocks.sessionKey = "session";
  useSkillDiffStore.setState({ candidatesByNote: new Map() });
  mocks.walkthrough.mockReset();
  mocks.successToast.mockReset();
  mocks.errorToast.mockReset();
  mocks.save.mockReset().mockResolvedValue(saved);
  mocks.apply.mockReset().mockReturnValue(true);
  mocks.resolveStaged.mockReset();
  mocks.restore.mockReset().mockResolvedValue(undefined);
  mocks.resolvePending.mockReset().mockResolvedValue(undefined);
  mocks.deleteArtifact.mockReset().mockResolvedValue(undefined);
  mocks.getDocument.mockReset().mockReturnValue({ type: 'doc', content: [] });
  mocks.run.mockReset();
  mocks.wasApplied.mockReset().mockReturnValue(false);
  mocks.prepare.mockReset().mockReturnValue("prepared");
  mocks.deliver.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  stageReview();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('applies a legacy receipt without preparing a durable application update', async () => {
  stageReview();
  useSkillDiffStore.getState().stage({ ...candidate, recoverable: true, durable: false, baseContent: '{}' });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
  await waitFor(() => expect(mocks.resolveStaged).toHaveBeenCalledWith('note', 'kept'));
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ durable: false }));
});

describe('skill review workflow integration', () => {
  it('identifies pending suggestions as review with separate apply, discard and refinement controls', () => {
    mount();
    expect(screen.getByText('skills.diff.review').tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: 'skills.diff.review' })).toBeNull();
    expect(screen.getByRole('button', { name: 'skills.diff.apply' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'skills.diff.discard' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'skills.diff.undo' })).toBeNull();
    expect(screen.getByPlaceholderText('skills.diff.describeChanges')).toBeTruthy();
  });

  it('keeps the same review identity while waiting for the editor', () => {
    render(<SkillDiffPendingBar noteId="note" compact />);
    expect(screen.getByText('skills.diff.review').tagName).toBe('SPAN');
    expect(screen.getByText('skills.diff.waitingForDocument')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'skills.diff.apply' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'skills.diff.discard' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('fetches a committed update before stale-target checks after a lost preparation response', async () => {
    useSkillDiffStore.getState().stage({ ...candidate, mode: 'replace-doc', recoverable: true, durable: true,
      baseContent: 'old body', acceptance: { result: saved } });
    mocks.save.mockResolvedValue({ ...saved, applicationUpdate: 'canonical' });
    mocks.wasApplied.mockReturnValueOnce(false).mockReturnValue(true);
    mount({ beforeApplyComplete: mocks.deliver });
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(mocks.resolvePending).toHaveBeenCalledWith('note', 'result', { durable: true }));
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), 'canonical', undefined);
    expect(mocks.deliver).toHaveBeenCalledOnce();
  });

  it('retains the proposal when discard fails offline and retires it after retry', async () => {
    mocks.resolvePending.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.discard' }));
    await waitFor(() => expect(mocks.resolvePending).toHaveBeenCalledOnce());
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeDefined();
    await waitFor(() => expect((screen.getByRole('button', { name: 'skills.diff.discard' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.discard' }));
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined());
  });

  it('completes legacy non-workflow acceptance after releasing its editor lock', async () => {
    mocks.workflow = null;
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(mocks.resolveStaged).toHaveBeenCalledWith('note', 'kept'));
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.successToast).not.toHaveBeenCalled();
    expect(useNoteCreatedNotice.getState().notice?.message).toBe('skills.diff.newSectionAdded');
  });

  it('does not apply an old account response after its candidates are cleared', async () => {
    mocks.workflow = null;
    let complete!: (value: typeof saved) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    act(() => { mocks.sessionKey = 'other-session'; useSkillDiffStore.getState().clear('note'); });
    await act(async () => complete(saved));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.resolvePending).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });

  it('waits for the document delivery barrier even without a workflow host', async () => {
    mocks.workflow = null;
    useSkillDiffStore.getState().stage({ ...candidate, recoverable: true, durable: true, baseContent: 'original',
      acceptance: { result: { ...saved, applicationUpdate: 'canonical' }, applied: true } });
    mocks.deliver.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(mocks.deliver).toHaveBeenCalledOnce());
    expect(mocks.resolvePending).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(mocks.resolvePending).toHaveBeenCalledWith('note', 'result', { durable: true }));
  });

  it('keeps ownership through delivery failure and retries without saving or applying twice', async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    useSkillDiffStore.getState().stage({ ...candidate, recordingId: 'recording' });
    const restoreEditor = { isDestroyed: false } as Editor;
    mount({ beforeApplyComplete: deliver, restoreEditor });
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    expect(useSkillDiffStore.getState().getCandidate('note')?.acceptance?.applied).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('skills.diff.deliveryPending');
    expect((screen.getByRole('button', { name: 'skills.diff.discard' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(mocks.walkthrough).toHaveBeenCalledWith({ type: 'kept', noteId: 'note', recordingId: 'recording' });
    expect(mocks.successToast).not.toHaveBeenCalled();
    expect(useNoteCreatedNotice.getState().notice).toMatchObject({ message: 'skills.diff.newSectionAdded', undo: expect.any(Function) });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.resolveStaged).toHaveBeenCalledWith('note', 'kept');
  });

  it('preserves the first apply baseline across delivery retries and updates the exact run on Undo', async () => {
    const original = { type: 'doc', content: [{ type: 'paragraph' }] };
    const applied = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Applied' }] }] };
    const newer = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Collaborator edit' }] }] };
    mocks.getDocument.mockReturnValue(original);
    mocks.apply.mockImplementation(() => { mocks.getDocument.mockReturnValue(applied); return true; });
    mocks.deliver.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    useSkillDiffStore.getState().stage({ ...candidate, activityId: 'specific-run' });
    mount({ beforeApplyComplete: mocks.deliver });
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    expect(useSkillDiffStore.getState().getCandidate('note')?.acceptance?.appliedContent).toBe(JSON.stringify(applied));
    mocks.getDocument.mockReturnValue(newer);
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(mocks.resolveRun).toHaveBeenCalledWith('specific-run', 'kept');
    const restore = vi.fn().mockReturnValue(true);
    const reopened = { isDestroyed: false, getJSON: () => newer, commands: { setContent: restore } } as unknown as Editor;
    await act(async () => { useNoteCreatedNotice.getState().notice!.undo!(reopened); });
    expect(restore).not.toHaveBeenCalled();
    expect(useNoteCreatedNotice.getState().notice?.message).toBe('skills.diff.undoAfterEdit');
    await act(async () => { useNoteCreatedNotice.getState().notice!.undo!({ ...reopened, getJSON: () => applied } as Editor); });
    await waitFor(() => expect(mocks.undoAccepted).toHaveBeenCalledWith('specific-run'));
  });

  it('ends an applied workflow with unavailable document without deleting the accepted artifact', async () => {
    useSkillDiffStore.getState().stage({ ...candidate, acceptance: { result: saved, applied: true } });
    render(<SkillDiffPendingBar noteId="note" />);
    expect((screen.getByRole('button', { name: 'skills.diff.apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'workflow.end' }));
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
    expect(mocks.resolvePending).not.toHaveBeenCalled();
    expect(mocks.deleteArtifact).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it('rechecks original note write access after saving the artifact', async () => {
    let finish!: (value: typeof saved) => void;
    let writable = true;
    mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount({ canApply: () => writable });
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    writable = false;
    await act(async () => { finish(saved); });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' });
    expect(useSkillDiffStore.getState().getCandidate('note')?.acceptance?.applied).not.toBe(true);
  });

  it('admits one Accept and blocks recording until the artifact and editor operation finish', async () => {
    let finish!: (value: typeof saved) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount();
    const keep = screen.getByRole('button', { name: 'skills.diff.apply' });
    act(() => { fireEvent.click(keep); fireEvent.click(keep); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(runtime().getSnapshot()).toMatchObject({ kind: 'skill', phase: 'applying' });
    expect(runtime().dispatch({ type: 'startRecording', workflowId: 'recording', noteId: 'other' }).accepted).toBe(false);
    expect(mocks.apply).not.toHaveBeenCalled();
    await act(async () => { finish(saved); });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });

  it('keeps a failed artifact save in review with the original proposal', async () => {
    mocks.save.mockRejectedValue(new Error('offline'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'proposal' }));
    expect(useSkillDiffStore.getState().getCandidate('note')).toEqual({ ...candidate, autoApply: false });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(runtime().dispatch({ type: 'startRecording', workflowId: 'recording', noteId: 'other' }).accepted).toBe(false);
  });

  it('declines and clears the proposal, and refuses a stale Accept after recording starts', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.discard' }));
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
    expect(mocks.resolvePending).toHaveBeenCalledWith('note', 'result', { discardAccepted: true });
    expect(runtime().dispatch({ type: 'startRecording', workflowId: 'recording', noteId: 'other' }).accepted).toBe(true);
    expect(runtime().dispatch({ type: 'acceptProposal', workflowId: 'workflow', proposalId: 'proposal' }).accepted).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('restores review after the editor refuses an accepted artifact', async () => {
    mocks.apply.mockReturnValue(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'proposal' }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')).toMatchObject({ ...candidate, acceptance: { result: saved } });
    expect(mocks.resolveStaged).not.toHaveBeenCalledWith('note', 'kept');
  });

  it('reuses the saved receipt when a failed editor application is retried', async () => {
    mocks.apply.mockReturnValueOnce(false).mockReturnValue(true);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    expect(mocks.apply).toHaveBeenNthCalledWith(2, expect.objectContaining({ artifactId: 'artifact' }));
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.deleteArtifact).not.toHaveBeenCalled();
  });

  it('retires only the unapplied artifact when its retained proposal is declined', async () => {
    mocks.apply.mockReturnValue(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.discard' }));
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(mocks.resolvePending).toHaveBeenCalledWith('note', 'result', { discardAccepted: true });
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });

  it('does not apply or restage a result after its workflow owner is retired', async () => {
    let finish!: (value: typeof saved) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    act(() => {
      runtime().dispose();
      useSkillDiffStore.getState().clear('note');
    });
    await act(async () => { finish(saved); });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
  });

  it('retires a retained artifact when Decline is used before the note editor is available', async () => {
    useSkillDiffStore.getState().stage({ ...candidate, resultId: undefined, acceptance: { result: saved } });
    render(<SkillDiffPendingBar noteId="note" />);
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.discard' }));
    expect(mocks.deleteArtifact).toHaveBeenCalledWith('/apps/v1/me/artifacts/artifact');
    expect(mocks.restore).not.toHaveBeenCalled();
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });

  it('does not mutate or restore an old proposal after its skill host closes', async () => {
    let finish!: (value: typeof saved) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    const nextCandidate = { ...candidate, workflowId: 'next-workflow', proposalId: 'next-proposal' };
    act(() => {
      const active = runtime().getSnapshot();
      if (active.kind !== 'skill') throw new Error('Expected an applying skill');
      runtime().dispatch({ type: 'skillHostClosed', workflowId: active.workflowId, attempt: active.attempt });
      useSkillDiffStore.getState().clear('note');
      runtime().dispatch({ type: 'runSkill', workflowId: 'next-workflow', noteId: 'note', skillId: 'cleanup' });
      runtime().dispatch({ type: 'proposalReady', workflowId: 'next-workflow', attempt: 1, proposalId: 'next-proposal' });
      useSkillDiffStore.getState().stage(nextCandidate);
    });
    await act(async () => { finish(saved); });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')).toEqual(nextCandidate);
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'review', workflowId: 'next-workflow', proposalId: 'next-proposal' });
  });

  it('refuses refinement after an artifact was saved but its editor application failed', async () => {
    mocks.apply.mockReturnValue(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    const input = screen.getByRole('textbox', { name: 'skills.diff.refineInstruction' });
    expect((input as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Try a shorter draft' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'proposal' });
  });

  it('does not replace a note changed while the artifact save was pending', async () => {
    let finish!: (value: typeof saved) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    useSkillDiffStore.getState().stage({ ...candidate, mode: 'replace-doc', baseContent: JSON.stringify(mocks.getDocument()) });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    mocks.getDocument.mockReturnValue({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New edit' }] }] });
    await act(async () => { finish(saved); });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'proposal' });
    expect(useSkillDiffStore.getState().getCandidate('note')).toMatchObject({ acceptance: { result: saved } });
  });

  it('does not save an artifact when the replacement target already changed', async () => {
    useSkillDiffStore.getState().stage({ ...candidate, mode: 'replace-doc', baseContent: 'old-document' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('keeps the pending-document decline blocked while refinement owns the proposal', async () => {
    runtime().dispatch({ type: 'refineSkill', workflowId: 'workflow', proposalId: 'proposal' });
    render(<SkillDiffPendingBar noteId="note" />);
    const decline = screen.getByRole('button', { name: 'skills.diff.discard' });
    expect((decline as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(decline);
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'running', proposalId: 'proposal' });
    expect(useSkillDiffStore.getState().getCandidate('note')).toEqual(candidate);
    const state = runtime().getSnapshot();
    if (state.kind !== 'skill') throw new Error('Expected active refinement');
    act(() => { runtime().dispatch({ type: 'skillCancelled', workflowId: state.workflowId, attempt: state.attempt }); });
    expect((decline as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(decline);
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });
});

 it('keeps a pending legacy suggestion until its saved result is discarded', async () => {
  mocks.workflow = null;
  let resolve!: () => void;
  mocks.resolvePending.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  render(<SkillDiffPendingBar noteId="note" />);
  fireEvent.click(screen.getByRole('button', { name: 'skills.diff.discard' }));
  expect(mocks.resolvePending).toHaveBeenCalledWith('note', 'result', { discardAccepted: true });
  expect(useSkillDiffStore.getState().getCandidate('note')).toBeDefined();
  await act(async () => resolve());
  expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
});

it('preserves a pending legacy suggestion when discard fails', async () => {
  mocks.workflow = null;
  mocks.resolvePending.mockRejectedValueOnce(new Error('offline'));
  render(<SkillDiffPendingBar noteId="note" />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'skills.diff.discard' })));
  expect(useSkillDiffStore.getState().getCandidate('note')).toBeDefined();
  expect(mocks.resolveStaged).not.toHaveBeenCalled();
});


describe('empty enhancement automatic application', () => {
  const empty = { type: 'doc', content: [] };
  const typed = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'My typing' }] }] };
  const automatic = { ...candidate, autoApply: true, recoverable: true, durable: true, mode: 'replace-doc' as const,
    baseContent: JSON.stringify(empty) };
  function prepareAuto() {
    useSkillDiffStore.getState().stage(automatic);
    mocks.save.mockResolvedValueOnce(saved).mockResolvedValue({ ...saved, applicationUpdate: 'canonical' });
    mocks.wasApplied.mockReturnValueOnce(false).mockReturnValue(true);
  }
  it('applies once without Apply, waits for delivery and reports Note created', async () => {
    prepareAuto();
    mount();
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.resolvePending).toHaveBeenCalledOnce();
    expect(mocks.deliver).toHaveBeenCalledTimes(3);
    expect(mocks.successToast).not.toHaveBeenCalled();
    expect(useNoteCreatedNotice.getState().notice).toMatchObject({ message: 'skills.diff.noteCreated', undo: expect.any(Function) });
  });
  it('rechecks the synced document before accepting', async () => {
    prepareAuto();
    mocks.deliver.mockImplementation(async () => { mocks.getDocument.mockReturnValue(typed); });
    mount();
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')?.autoApply).toBe(false);
  });
  it('does not silently apply when typing lands during update preparation', async () => {
    prepareAuto();
    mocks.save.mockReset().mockResolvedValueOnce(saved).mockImplementation(async () => {
      mocks.getDocument.mockReturnValue(typed);
      return { ...saved, applicationUpdate: 'canonical' };
    });
    mount();
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate('note')?.acceptance?.result.applicationUpdate).toBe('canonical'));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.successToast).not.toHaveBeenCalled();
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' });
  });
  it('retains a committed update if sync fails immediately before application', async () => {
    prepareAuto();
    mocks.deliver.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disconnected'));
    mount();
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate('note')?.acceptance?.result.applicationUpdate).toBe('canonical'));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.successToast).not.toHaveBeenCalled();
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' });
  });
  it('retains failed saves and retries only through an explicit Apply', async () => {
    prepareAuto();
    mocks.save.mockReset().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(saved)
      .mockResolvedValue({ ...saved, applicationUpdate: 'canonical' });
    mocks.wasApplied.mockReset().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const view = mount();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    view.unmount();
    mount();
    expect(mocks.save).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.apply' }));
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(mocks.apply).toHaveBeenCalledOnce();
  });
  it('binds Undo to the reopened editor and retries delivery without overwriting later edits', async () => {
    const { useNoteCreatedNotice } = await import('../../../app-client/src/notes/note-created-notice');
    prepareAuto();
    const view = mount();
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    const notice = useNoteCreatedNotice.getState().notice!;
    view.unmount();
    const restore = vi.fn().mockReturnValue(true);
    const reopened = { isDestroyed: false, getJSON: () => empty, commands: { setContent: restore } } as unknown as Editor;
    mocks.deliver.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { notice.undo!(reopened); });
    await waitFor(() => expect(useNoteCreatedNotice.getState().notice).toMatchObject({ message: 'skills.diff.undoSyncFailed', description: 'skills.diff.restoredOnDevice', error: true }));
    expect(useNoteCreatedNotice.getState().notice?.undoPending).toBe(true);
    expect(mocks.deleteArtifact).not.toHaveBeenCalled();
    await act(async () => { notice.undo!(reopened); });
    await waitFor(() => expect(useNoteCreatedNotice.getState().notice).toMatchObject({ message: 'skills.diff.restoredPrevious', undo: undefined }));
    expect(mocks.deleteArtifact).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
  });
  it('does not include edits made during delivery in the Undo baseline', async () => {
    const { useNoteCreatedNotice } = await import('../../../app-client/src/notes/note-created-notice');
    prepareAuto();
    mocks.deliver.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      mocks.getDocument.mockReturnValue(typed);
    });
    mount();
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    const restore = vi.fn();
    const edited = { isDestroyed: false, getJSON: () => typed, commands: { setContent: restore } } as unknown as Editor;
    await act(async () => { useNoteCreatedNotice.getState().notice!.undo!(edited); });
    expect(restore).not.toHaveBeenCalled();
    expect(mocks.deleteArtifact).not.toHaveBeenCalled();
  });
  it('refuses snapshot Undo over newer user edits', async () => {
    const { useNoteCreatedNotice } = await import('../../../app-client/src/notes/note-created-notice');
    prepareAuto();
    mount();
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    const restore = vi.fn();
    const edited = { isDestroyed: false, getJSON: () => typed, commands: { setContent: restore } } as unknown as Editor;
    await act(async () => { useNoteCreatedNotice.getState().notice!.undo!(edited); });
    expect(restore).not.toHaveBeenCalled();
    expect(mocks.deleteArtifact).not.toHaveBeenCalled();
  });
  it('does not auto-accept a recovered pending suggestion', async () => {
    useSkillDiffStore.getState().stage({ ...automatic, autoApply: undefined });
    mount();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' });
  });
});

describe('review shine state boundary', () => {
  let nextResult = 0;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    stageReview();
    useSkillDiffStore.getState().stage({ ...candidate, resultId: `shine-result-${++nextResult}` });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('shines for ready review and stops while saving, on failure, and on resolution', () => {
    const view = mount();
    const dock = () => view.container.querySelector('[data-review-shine]');
    expect(dock()).not.toBeNull();
    act(() => { runtime().dispatch({ type: 'acceptProposal', workflowId: 'workflow', proposalId: 'proposal' }); });
    expect(dock()).toBeNull();
    act(() => { runtime().dispatch({ type: 'applyFailed', workflowId: 'workflow', attempt: 1, error: 'save-failed' }); });
    expect(dock()).toBeNull();
    act(() => { runtime().dispatch({ type: 'declineProposal', workflowId: 'workflow', proposalId: 'proposal' }); });
    expect(dock()).toBeNull();
  });
  it('does not shine while refining', () => {
    const view = mount();
    expect(view.container.querySelector('[data-review-shine]')).not.toBeNull();
    act(() => { runtime().dispatch({ type: 'refineSkill', workflowId: 'workflow', proposalId: 'proposal' }); });
    expect(view.container.querySelector('[data-review-shine]')).toBeNull();
  });
  it('does not flash attention before automatic empty-note application', async () => {
    useSkillDiffStore.getState().stage({ ...candidate, resultId: `shine-auto-${++nextResult}`, autoApply: true });
    mocks.save.mockImplementation(() => new Promise(() => {}));
    const view = mount();
    expect(view.container.querySelector('[data-review-shine]')).toBeNull();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(view.container.querySelector('[data-review-shine]')).toBeNull();
  });
});
