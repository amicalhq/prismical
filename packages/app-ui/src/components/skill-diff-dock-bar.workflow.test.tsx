// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import { createWorkflowRuntime, type WorkflowRuntime } from '@prismical/app-workflow';
import { useSkillDiffStore, type SkillDiffCandidate } from '../../../app-client/src/notes/diff/skill-diff-store';

const mocks = vi.hoisted(() => ({
  workflow: null as WorkflowRuntime | null,
  walkthrough: vi.fn(),
  successToast: vi.fn(),
  save: vi.fn(),
  apply: vi.fn(),
  resolveStaged: vi.fn(),
  restore: vi.fn(),
  resolvePending: vi.fn(),
  deleteArtifact: vi.fn(),
  getDocument: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@prismical/app-client', async () => {
  const React = await import('react');
  const { useSkillDiffStore } = await import('../../../app-client/src/notes/diff/skill-diff-store');
  const idle = { kind: 'idle' } as const;
  return {
    apiClient: { del: mocks.deleteArtifact },
    ME_PREFIX: '/apps/v1/me',
    usePorts: () => ({ workflow: mocks.workflow }),
    useWorkflowSnapshot: () => React.useSyncExternalStore(mocks.workflow?.subscribe ?? (() => () => {}), mocks.workflow?.getSnapshot ?? (() => idle)),
    useSkillDiffStore,
    useAcceptArtifact: () => ({ mutateAsync: mocks.save, isPending: false }),
    useRunSkill: () => ({ run: mocks.run, cancel: vi.fn(), running: false }),
    useSkillRunActivityStore: { getState: () => ({ resolveStaged: mocks.resolveStaged }) },
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
vi.mock('sonner', () => ({ toast: { success: mocks.successToast, error: vi.fn(), info: vi.fn() } }));
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
  useSkillDiffStore.setState({ candidatesByNote: new Map() });
  mocks.walkthrough.mockReset();
  mocks.successToast.mockReset();
  mocks.save.mockReset().mockResolvedValue(saved);
  mocks.apply.mockReset().mockReturnValue(true);
  mocks.resolveStaged.mockReset();
  mocks.restore.mockReset().mockResolvedValue(undefined);
  mocks.resolvePending.mockReset().mockResolvedValue(undefined);
  mocks.deleteArtifact.mockReset().mockResolvedValue(undefined);
  mocks.getDocument.mockReset().mockReturnValue({ type: 'doc', content: [] });
  mocks.run.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  stageReview();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('skill review workflow integration', () => {
  it('keeps ownership through delivery failure and retries without saving or applying twice', async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    useSkillDiffStore.getState().stage({ ...candidate, recordingId: 'recording' });
    const restoreEditor = { isDestroyed: false } as Editor;
    mount({ beforeApplyComplete: deliver, restoreEditor });
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    expect(useSkillDiffStore.getState().getCandidate('note')?.acceptance?.applied).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('skills.diff.deliveryPending');
    expect((screen.getByRole('button', { name: 'skills.diff.undo' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    await waitFor(() => expect(runtime().getSnapshot()).toEqual({ kind: 'idle' }));
    expect(mocks.walkthrough).toHaveBeenCalledWith({ type: 'kept', noteId: 'note', recordingId: 'recording' });
    expect(mocks.successToast).toHaveBeenCalledWith('skills.diff.newSectionAdded', expect.objectContaining({
      action: expect.objectContaining({ label: 'skills.diff.undo', onClick: expect.any(Function) }),
    }));
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.resolveStaged).toHaveBeenCalledWith('note', 'kept');
  });

  it('ends an applied workflow with unavailable document without deleting the accepted artifact', () => {
    useSkillDiffStore.getState().stage({ ...candidate, acceptance: { result: saved, applied: true } });
    render(<SkillDiffPendingBar noteId="note" skillName="Cleanup" />);
    expect((screen.getByRole('button', { name: 'skills.diff.keep' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'workflow.end' }));
    expect(runtime().getSnapshot()).toEqual({ kind: 'idle' });
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
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
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
    const keep = screen.getByRole('button', { name: 'skills.diff.keep' });
    act(() => { fireEvent.click(keep); fireEvent.click(keep); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(runtime().getSnapshot()).toMatchObject({ kind: 'skill', phase: 'applying' });
    expect(runtime().dispatch({ type: 'startRecording', workflowId: 'recording', noteId: 'other' }).accepted).toBe(false);
    expect(mocks.apply).not.toHaveBeenCalled();
    await act(async () => { finish(saved); });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(runtime().getSnapshot()).toEqual({ kind: 'idle' });
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });

  it('keeps a failed artifact save in review with the original proposal', async () => {
    mocks.save.mockRejectedValue(new Error('offline'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'proposal' }));
    expect(useSkillDiffStore.getState().getCandidate('note')).toEqual(candidate);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(runtime().dispatch({ type: 'startRecording', workflowId: 'recording', noteId: 'other' }).accepted).toBe(false);
  });

  it('declines and clears the proposal, and refuses a stale Accept after recording starts', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.undo' }));
    expect(runtime().getSnapshot()).toEqual({ kind: 'idle' });
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
    expect(mocks.resolvePending).toHaveBeenCalledWith('note', 'result', { discardAccepted: true });
    expect(runtime().dispatch({ type: 'startRecording', workflowId: 'recording', noteId: 'other' }).accepted).toBe(true);
    expect(runtime().dispatch({ type: 'acceptProposal', workflowId: 'workflow', proposalId: 'proposal' }).accepted).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('restores review after the editor refuses an accepted artifact', async () => {
    mocks.apply.mockReturnValue(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.undo' }));
    expect(runtime().getSnapshot()).toEqual({ kind: 'idle' });
    expect(mocks.resolvePending).toHaveBeenCalledWith('note', 'result', { discardAccepted: true });
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });

  it('does not apply or restage a result after its workflow owner is retired', async () => {
    let finish!: (value: typeof saved) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    act(() => {
      runtime().dispose();
      useSkillDiffStore.getState().clear('note');
    });
    await act(async () => { finish(saved); });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
    expect(runtime().getSnapshot()).toEqual({ kind: 'idle' });
  });

  it('retires a retained artifact when Decline is used before the note editor is available', () => {
    useSkillDiffStore.getState().stage({ ...candidate, resultId: undefined, acceptance: { result: saved } });
    render(<SkillDiffPendingBar noteId="note" skillName="Cleanup" />);
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.undo' }));
    expect(mocks.deleteArtifact).toHaveBeenCalledWith('/apps/v1/me/artifacts/artifact');
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(runtime().getSnapshot()).toEqual({ kind: 'idle' });
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });

  it('does not mutate or restore an old proposal after its skill host closes', async () => {
    let finish!: (value: typeof saved) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    mocks.getDocument.mockReturnValue({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New edit' }] }] });
    await act(async () => { finish(saved); });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'proposal' });
    expect(useSkillDiffStore.getState().getCandidate('note')).toMatchObject({ acceptance: { result: saved } });
  });

  it('does not save an artifact when the replacement target already changed', async () => {
    useSkillDiffStore.getState().stage({ ...candidate, mode: 'replace-doc', baseContent: 'old-document' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    await waitFor(() => expect(runtime().getSnapshot()).toMatchObject({ phase: 'review' }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('keeps the pending-document decline blocked while refinement owns the proposal', () => {
    runtime().dispatch({ type: 'refineSkill', workflowId: 'workflow', proposalId: 'proposal' });
    render(<SkillDiffPendingBar noteId="note" skillName="Cleanup" />);
    const decline = screen.getByRole('button', { name: 'skills.diff.undo' });
    expect((decline as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(decline);
    expect(runtime().getSnapshot()).toMatchObject({ phase: 'running', proposalId: 'proposal' });
    expect(useSkillDiffStore.getState().getCandidate('note')).toEqual(candidate);
    const state = runtime().getSnapshot();
    if (state.kind !== 'skill') throw new Error('Expected active refinement');
    act(() => { runtime().dispatch({ type: 'skillCancelled', workflowId: state.workflowId, attempt: state.attempt }); });
    expect((decline as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(decline);
    expect(runtime().getSnapshot()).toEqual({ kind: 'idle' });
    expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
  });
});

 it('keeps a pending legacy suggestion until its saved result is discarded', async () => {
  mocks.workflow = null;
  let resolve!: () => void;
  mocks.resolvePending.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  render(<SkillDiffPendingBar noteId="note" skillName="Cleanup" />);
  fireEvent.click(screen.getByRole('button', { name: 'skills.diff.undo' }));
  expect(mocks.resolvePending).toHaveBeenCalledWith('note', 'result');
  expect(useSkillDiffStore.getState().getCandidate('note')).toBeDefined();
  await act(async () => resolve());
  expect(useSkillDiffStore.getState().getCandidate('note')).toBeUndefined();
});

it('preserves a pending legacy suggestion when discard fails', async () => {
  mocks.workflow = null;
  mocks.resolvePending.mockRejectedValueOnce(new Error('offline'));
  render(<SkillDiffPendingBar noteId="note" skillName="Cleanup" />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'skills.diff.undo' })));
  expect(useSkillDiffStore.getState().getCandidate('note')).toBeDefined();
  expect(mocks.resolveStaged).not.toHaveBeenCalled();
});
