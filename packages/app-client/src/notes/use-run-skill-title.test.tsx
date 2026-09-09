// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { observable } from '@legendapp/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import { ApiError } from '../api/client';
import { useSkillRunActivityStore } from './skill-run-activity-store';
import { useAutoEnhanceStore } from './auto-enhance-store';
import { setTitleDraftDirty } from './title-drafts';
import { useSkillDiffStore } from './diff/skill-diff-store';
import { createWorkflowRuntime, type WorkflowRuntime } from '@prismical/app-workflow';

const mocks = vi.hoisted(() => ({
  store: null as unknown,
  request: vi.fn(),
  mutate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  capture: vi.fn(),
  workflow: undefined as WorkflowRuntime | undefined,
  native: false,
  resolve: vi.fn(),
}));
vi.mock('../sync/provider', () => ({ useSyncStore: () => mocks.store }));
vi.mock('../api/hooks/skill-runs', () => ({
  runSkillRequest: mocks.request,
  mutateTitleRun: mocks.mutate,
  resolvePendingSkillResult: mocks.resolve,
}));
vi.mock('../api/hooks/model-defaults', () => ({ ensureModelDefault: async () => ({}) }));
vi.mock('../ports-context', () => ({
  usePorts: () => ({ analytics: { capture: mocks.capture }, workflow: mocks.workflow, recording: { control: mocks.native ? {} : undefined } }),
  // The recovery actions ("Open AI models") navigate; the title flow never triggers one.
  useNavigation: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error, info: vi.fn() } }));
const { useRunSkill } = await import('./use-run-skill');
const noteId = 'nt_title_test';
const args = {
  skillId: 'skl_name_note',
  skillName: 'Name note',
  outputTarget: 'note-title' as const,
};
const result = {
  outputTarget: 'note-title',
  titleRunId: 'run_test',
  title: 'Launch plan',
  skillId: args.skillId,
};
const dirtyOwner = Symbol('test');
let notes$: ReturnType<
  typeof observable<Record<string, { title: string; titleSource: string; titleRevision: number }>>
>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workflow = undefined;
  mocks.native = false;
  mocks.resolve.mockResolvedValue(undefined);
  useSkillRunActivityStore.setState({ runningByNote: new Map(), runsByNote: new Map() });
  notes$ = observable<
    Record<string, { title: string; titleSource: string; titleRevision: number }>
  >({
    [noteId]: { title: 'Original', titleSource: 'manual', titleRevision: 1 },
  });
  mocks.store = { notes$ };
  mocks.request.mockResolvedValue(result);
  mocks.mutate.mockResolvedValue({
    noteId,
    title: 'Launch plan',
    titleSource: 'ai',
    titleRevision: 2,
  });
  useSkillDiffStore.getState().clear(noteId);
  setTitleDraftDirty(noteId, dirtyOwner, false);
});

describe('page workflow skill ownership', () => {
  const body = {
    skillId: 'skl_enhance', skillName: 'Enhance', modelId: 'test-model',
    mode: 'replace-doc', rawMarkdown: 'Summary', reasoning: null,
  };
  const editor = { getJSON: () => ({ type: 'doc', content: [] }) } as unknown as Editor;

  beforeEach(() => { mocks.workflow = createWorkflowRuntime(); });

  function reserveEnhancement() {
    const workflow = mocks.workflow!;
    workflow.dispatch({ type: 'startRecording', workflowId: 'recording', noteId });
    workflow.dispatch({ type: 'captureReady', workflowId: 'recording', attempt: 1, recordingId: 'rec' });
    workflow.dispatch({ type: 'stopRecording', workflowId: 'recording' });
    workflow.dispatch({ type: 'inputDrained', workflowId: 'recording', attempt: 2 });
    workflow.dispatch({ type: 'finalizationSucceeded', workflowId: 'recording', attempt: 3, autoSkill: { skillId: body.skillId } });
    return workflow;
  }

  it('refuses a skill while another note is recording before making a request', async () => {
    mocks.workflow!.dispatch({ type: 'startRecording', workflowId: 'recording', noteId: 'another-note' });
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run(args));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.workflow!.getSnapshot()).toMatchObject({ kind: 'recording' });
  });

  it('retains review ownership after generation and note unmount', async () => {
    mocks.request.mockResolvedValue(body);
    const { result: hook, unmount } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName, source: 'auto-enhance' }));
    const proposal = useSkillDiffStore.getState().getCandidate(noteId)!;
    expect(mocks.request.mock.calls[0]![1]).toMatchObject({ recoverable: false, retainResult: true });
    expect(mocks.workflow!.getSnapshot()).toMatchObject({
      kind: 'skill', phase: 'review', workflowId: proposal.workflowId, proposalId: proposal.proposalId,
    });
    unmount();
    expect(mocks.workflow!.dispatch({ type: 'startRecording', workflowId: 'next', noteId: 'another-note' }).accepted).toBe(false);
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(proposal);
  });

  it('admits exactly one of two simultaneous skill runs from different hook instances', async () => {
    const finish = delayedResult();
    const first = renderHook(() => useRunSkill(noteId, null));
    const second = renderHook(() => useRunSkill('another-note', null));
    let pending!: Promise<void>;
    act(() => { pending = first.result.current.run(args); });
    await act(() => second.result.current.run(args));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await pending; });
    expect(mocks.workflow!.getSnapshot()).toEqual({ kind: 'idle' });
  });

  it('preserves the previous proposal when refinement fails', async () => {
    mocks.request.mockResolvedValue(body);
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName }));
    const proposal = useSkillDiffStore.getState().getCandidate(noteId)!;
    mocks.request.mockRejectedValue(new ApiError('NOTE_EMPTY', 'Empty', 400));
    await act(() => hook.current.run({
      skillId: body.skillId, skillName: body.skillName, source: 'refine',
      proposalId: proposal.proposalId, refineInstruction: 'Shorter', previousOutput: body.rawMarkdown,
    }));
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(proposal);
    expect(mocks.workflow!.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'review', proposalId: proposal.proposalId, attempt: 2 });
  });

  it('rejects refinement of an older proposal before execution', async () => {
    mocks.request.mockResolvedValue(body);
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName }));
    await act(() => hook.current.run({
      skillId: body.skillId, skillName: body.skillName, source: 'refine', proposalId: 'old-proposal',
      refineInstruction: 'Shorter', previousOutput: body.rawMarkdown,
    }));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.workflow!.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'review', attempt: 1 });
  });

  it('refuses refinement of a saved artifact that still needs editor application', async () => {
    mocks.request.mockResolvedValue(body);
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName }));
    const proposal = useSkillDiffStore.getState().getCandidate(noteId)!;
    useSkillDiffStore.getState().stage({ ...proposal, acceptance: { result: {
      artifactId: 'saved-artifact', version: 1, generatedAt: '2026-09-09T00:00:00.000Z',
    } } });
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName,
      source: 'refine', proposalId: proposal.proposalId, refineInstruction: 'Shorter' }));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.workflow!.getSnapshot()).toMatchObject({ phase: 'review', proposalId: proposal.proposalId });
  });

  it('keeps the original body revision when edits arrive while generating a replacement', async () => {
    const original = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original' }] }] };
    let doc = original;
    let finish!: (value: typeof body) => void;
    mocks.request.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const liveEditor = { getJSON: () => doc } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, liveEditor));
    let pending!: Promise<void>;
    act(() => { pending = hook.current.run({ skillId: body.skillId, skillName: body.skillName }); });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New edit' }] }] };
    await act(async () => { finish(body); await pending; });
    expect(useSkillDiffStore.getState().getCandidate(noteId)?.baseContent).toBe(JSON.stringify(original));
  });

  it('uses the current document for refinement even without caller-supplied markdown', async () => {
    mocks.request.mockResolvedValue(body);
    let text = 'Original local body';
    const liveEditor = { getJSON: () => ({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
    ] }) } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, liveEditor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName }));
    expect(mocks.request.mock.calls[0]![1].noteMarkdown).toContain('Original local body');
    const proposal = useSkillDiffStore.getState().getCandidate(noteId)!;
    text = 'Latest collaborator edit';
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName,
      source: 'refine', proposalId: proposal.proposalId, refineInstruction: 'Shorter' }));
    expect(mocks.request.mock.calls[1]![1].noteMarkdown).toContain('Latest collaborator edit');
    expect(useSkillDiffStore.getState().getCandidate(noteId)?.baseContent).toBe(JSON.stringify(liveEditor.getJSON()));
  });

  const unsendableDocuments = [
    ['oversized', { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'x'.repeat(1_000_001) },
    ] }] }],
    ['unserializable', { type: 'doc', content: [{ type: 'unsupported-node' }] }],
  ] as const;

  it.each(unsendableDocuments)('refuses an %s live body without calling the model', async (_reason, doc) => {
    const liveEditor = { getJSON: () => doc } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, liveEditor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName }));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('skills.run.failed');
    expect(mocks.workflow!.getSnapshot()).toEqual({ kind: 'idle' });
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBeUndefined();
  });

  it.each(unsendableDocuments)('retains the previous proposal when refinement has an %s body', async (_reason, doc) => {
    mocks.request.mockResolvedValue(body);
    let current: unknown = { type: 'doc', content: [] };
    const liveEditor = { getJSON: () => current } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, liveEditor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName }));
    const proposal = useSkillDiffStore.getState().getCandidate(noteId)!;
    current = doc;
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName,
      source: 'refine', proposalId: proposal.proposalId, refineInstruction: 'Shorter' }));
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith('skills.run.failed');
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(proposal);
    expect(mocks.workflow!.getSnapshot()).toMatchObject({ phase: 'review', proposalId: proposal.proposalId });
  });

  it.each(unsendableDocuments)('preserves legacy server fallback for an %s body', async (_reason, doc) => {
    mocks.workflow = undefined;
    const liveEditor = { getJSON: () => doc } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, liveEditor));
    await act(() => hook.current.run(args));
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls[0]![1].noteMarkdown).toBeUndefined();
    expect(mocks.mutate).toHaveBeenCalledWith('apply', 'run_test');
  });

  it('uses a fresh receipt for refinement and retires only its previous result', async () => {
    mocks.request.mockResolvedValueOnce({ ...body, resultId: 'previous-result' })
      .mockResolvedValueOnce({ ...body, resultId: 'refined-result' });
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName }));
    const proposal = useSkillDiffStore.getState().getCandidate(noteId)!;
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName,
      source: 'refine', proposalId: proposal.proposalId, refineInstruction: 'Shorter' }));
    expect(mocks.request.mock.calls[1]![1]).toMatchObject({ retainResult: true, recoverable: false });
    expect(mocks.request.mock.calls[1]![1].recoveryResultId).toBeUndefined();
    expect(mocks.resolve).toHaveBeenCalledWith(noteId, 'previous-result', { discardAccepted: true });
    expect(useSkillDiffStore.getState().getCandidate(noteId)?.resultId).toBe('refined-result');
  });

  it.each(['auto-enhance', 'wand'] as const)('keeps native %s output and its refinement recoverable with fresh identities', async source => {
    mocks.native = true;
    mocks.request.mockResolvedValueOnce({ ...body, recordingId: 'rec', resultId: 'original' })
      .mockResolvedValueOnce({ ...body, recordingId: 'rec', resultId: 'refined' });
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName, recordingId: 'rec', source }));
    expect(mocks.request.mock.calls[0]![1]).toMatchObject({ recoverable: true, retainResult: true });
    const proposal = useSkillDiffStore.getState().getCandidate(noteId)!;
    expect(proposal.recoverable).toBe(true);
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName,
      recordingId: 'rec', source: 'refine', proposalId: proposal.proposalId,
      refineInstruction: 'Shorter', previousOutput: proposal.rawMarkdown }));
    expect(mocks.request.mock.calls[1]![1]).toMatchObject({ recoverable: true, retainResult: true });
    expect(mocks.request.mock.calls[1]![1].recoveryResultId).toBeUndefined();
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toMatchObject({ resultId: 'refined', recoverable: true });
    expect(mocks.resolve).toHaveBeenCalledWith(noteId, 'original', { discardAccepted: true });
  });

  it('keeps native manual recording receipts out of restart recovery when refined', async () => {
    mocks.native = true;
    mocks.request.mockResolvedValueOnce({ ...body, recordingId: 'rec', resultId: 'original' })
      .mockResolvedValueOnce({ ...body, recordingId: 'rec', resultId: 'refined' });
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName, recordingId: 'rec' }));
    const proposal = useSkillDiffStore.getState().getCandidate(noteId)!;
    expect(proposal.recoverable).toBe(false);
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName,
      recordingId: 'rec', source: 'refine', proposalId: proposal.proposalId, refineInstruction: 'Shorter' }));
    expect(mocks.request.mock.calls[1]![1]).toMatchObject({ retainResult: true, recoverable: false });
  });

  it('takes the reserved enhancement handoff without admitting another workflow', async () => {
    const workflow = reserveEnhancement();
    mocks.request.mockResolvedValue(body);
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName, workflowId: 'recording', recordingId: 'rec', source: 'auto-enhance' }));
    expect(workflow.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'review', workflowId: 'recording' });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', null],
    ['destroyed', { isDestroyed: true } as Editor],
  ] as const)('releases its reserved enhancement when the editor is %s', async (_name, unavailableEditor) => {
    const workflow = reserveEnhancement();
    const { result: hook } = renderHook(() => useRunSkill(noteId, unavailableEditor));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName,
      workflowId: 'recording', recordingId: 'rec', source: 'auto-enhance' }));
    expect(workflow.getSnapshot()).toEqual({ kind: 'idle' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('does not release another reserved enhancement when an unavailable editor rejects a stale request', async () => {
    const workflow = reserveEnhancement();
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    await act(() => hook.current.run({ skillId: body.skillId, skillName: body.skillName,
      workflowId: 'older-recording', recordingId: 'rec', source: 'auto-enhance' }));
    expect(workflow.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'running', workflowId: 'recording' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('keeps title mutation ownership through unmount until the server settles', async () => {
    let finishApply!: () => void;
    mocks.mutate.mockReturnValueOnce(new Promise(resolve => {
      finishApply = () => resolve({ noteId, title: 'Launch plan', titleSource: 'ai', titleRevision: 2 });
    }));
    const { result: hook, unmount } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => { pending = hook.current.run(args); });
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    unmount();
    expect(mocks.workflow!.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'running' });
    await act(async () => { finishApply(); await pending; });
    expect(mocks.workflow!.getSnapshot()).toEqual({ kind: 'idle' });
    expect(notes$[noteId]!.title.peek()).toBe('Original');
  });

  it('does not let a title Undo toast mutate during a new recording', async () => {
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    await act(() => hook.current.run(args));
    mocks.workflow!.dispatch({ type: 'startRecording', workflowId: 'next', noteId });
    act(() => mocks.success.mock.calls[0]![1].action.onClick());
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.workflow!.getSnapshot()).toMatchObject({ kind: 'recording' });
  });
});
afterEach(() => {
  cleanup();
  setTitleDraftDirty(noteId, dirtyOwner, false);
});

function delayedResult() {
  let resolve!: (value: typeof result) => void;
  mocks.request.mockReturnValue(
    new Promise<typeof result>(done => {
      resolve = done;
    })
  );
  return () => resolve(result);
}

describe('title skill result dispatch', () => {
  it('records a note-body suggestion only after it is staged', async () => {
    mocks.request.mockResolvedValue({ skillId: 'skl_enhance', skillName: 'Enhance', modelId: 'test-model', mode: 'replace-doc', rawMarkdown: 'Summary', reasoning: null });
    const editor = { getJSON: () => ({ type: 'doc', content: [] }) } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: 'skl_enhance', skillName: 'Enhance' }));
    expect(useSkillDiffStore.getState().getCandidate(noteId)?.rawMarkdown).toBe('Summary');
    const terminal = mocks.capture.mock.calls.filter(([event]) => event === 'skill_run_finished');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.[1]).toMatchObject({ status: 'staged', model_id: 'test-model', request_count: 1 });
  });
  it('records an abandoned attempt when its editor unmounts', async () => {
    const finish = delayedResult();
    const { result: hook, unmount } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => { pending = hook.current.run(args); });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    unmount();
    expect(mocks.capture).toHaveBeenCalledWith('skill_run_finished', expect.objectContaining({ status: 'abandoned' }));
    await act(async () => { finish(); await pending; });
    expect(mocks.capture.mock.calls.filter(([event]) => event === 'skill_run_finished')).toHaveLength(1);
  });

  it('emits one terminal event after the result is applied', async () => {
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    await act(() => hook.current.run(args));
    expect(mocks.capture).toHaveBeenCalledWith(
      'skill_run_started',
      expect.objectContaining({ skill_id: args.skillId })
    );
    const terminal = mocks.capture.mock.calls.filter(([event]) => event === 'skill_run_finished');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.[1]).toMatchObject({
      status: 'applied',
      duration_ms: expect.any(Number),
      request_count: 1,
    });
  });
  it('publishes the transcript wait and lets another panel cancel it without retrying', async () => {
    useSkillRunActivityStore.setState({ runsByNote: new Map(), runningByNote: new Map() });
    mocks.request.mockRejectedValue(new ApiError('TRANSCRIPT_FINALIZING', 'Waiting', 409, { retryAfterMs: 30_000 }));
    const editor = { getJSON: () => ({ type: 'doc', content: [] }) } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    let pending!: Promise<void>;
    act(() => { pending = hook.current.run({ skillId: 'skl_enhance', skillName: 'Enhance', recordingId: 'rec_1' }); });
    await waitFor(() => expect(useSkillRunActivityStore.getState().runsByNote.get(noteId)?.[0]?.phase).toBe('waiting-transcript'));
    await act(async () => {
      useSkillRunActivityStore.getState().runsByNote.get(noteId)?.[0]?.cancel?.();
      await pending;
    });
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(useSkillRunActivityStore.getState().runsByNote.get(noteId)?.[0]?.status).toBe('stopped');
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBeUndefined();
  });

  it('records cancellation immediately even when the request has not settled', async () => {
    const finish = delayedResult();
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(args);
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    act(() => hook.current.cancel());
    expect(mocks.capture).toHaveBeenCalledWith(
      'skill_run_finished',
      expect.objectContaining({ status: 'stopped' })
    );
    await act(async () => {
      finish();
      await pending;
    });
    expect(
      mocks.capture.mock.calls.filter(([event]) => event === 'skill_run_finished')
    ).toHaveLength(1);
  });

  it('applies immediately, without staging a body diff, and offers guarded Undo', async () => {
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    await act(() => hook.current.run(args));
    expect(mocks.mutate).toHaveBeenCalledWith('apply', 'run_test');
    expect(notes$[noteId]!.title.peek()).toBe('Launch plan');
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBeUndefined();
    mocks.mutate.mockResolvedValueOnce({
      noteId,
      title: 'Original',
      titleSource: 'manual',
      titleRevision: 3,
    });
    act(() => mocks.success.mock.calls[0]![1].action.onClick());
    await waitFor(() => expect(notes$[noteId]!.title.peek()).toBe('Original'));
    expect(mocks.mutate).toHaveBeenLastCalledWith('undo', 'run_test');
  });
  it('sends the current editor body, before the persisted snapshot catches up', async () => {
    const editor = {
      getJSON: () => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just typed' }] }],
      }),
    } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run(args));
    expect(mocks.request.mock.calls[0]![1].noteMarkdown).toContain('Just typed');
  });
  it('does not apply a result after a manual rename while generation was running', async () => {
    const finish = delayedResult();
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(args);
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    notes$[noteId]!.title.set('My manual name');
    await act(async () => {
      finish();
      await pending;
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(notes$[noteId]!.title.peek()).toBe('My manual name');
  });
  it('applies after the default title catches up with a body autosave during generation', async () => {
    notes$[noteId]!.assign({
      title: 'Untitled note',
      titleSource: 'placeholder',
      titleRevision: 0,
    });
    const finish = delayedResult();
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(args);
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    notes$[noteId]!.assign({ title: 'Just typed', titleSource: 'first-line' });
    await act(async () => {
      finish();
      await pending;
    });
    expect(mocks.mutate).toHaveBeenCalledWith('apply', 'run_test');
    expect(notes$[noteId]!.title.peek()).toBe('Launch plan');
    expect(mocks.error).not.toHaveBeenCalled();
  });
  it('merges the applied title if a default-title sync arrives while apply is in flight', async () => {
    notes$[noteId]!.assign({ title: 'First line', titleSource: 'first-line', titleRevision: 0 });
    let finishApply!: () => void;
    mocks.mutate.mockReturnValueOnce(
      new Promise(resolve => {
        finishApply = () =>
          resolve({ noteId, title: 'Launch plan', titleSource: 'ai', titleRevision: 1 });
      })
    );
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(args);
    });
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    notes$[noteId]!.title.set('New first line');
    await act(async () => {
      finishApply();
      await pending;
    });
    expect(notes$[noteId]!.title.peek()).toBe('Launch plan');
  });
  it('rejects an explicit reset while generating even when both states follow the body', async () => {
    notes$[noteId]!.assign({ title: 'First line', titleSource: 'first-line', titleRevision: 0 });
    const finish = delayedResult();
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(args);
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    notes$[noteId]!.assign({ title: 'First line', titleSource: 'first-line', titleRevision: 1 });
    await act(async () => {
      finish();
      await pending;
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('notes.titleConflict');
  });
  it('does not replace a manual edit with the same text as the default', async () => {
    notes$[noteId]!.assign({ title: 'First line', titleSource: 'first-line', titleRevision: 0 });
    const finish = delayedResult();
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(args);
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    notes$[noteId]!.assign({ titleSource: 'manual' });
    await act(async () => {
      finish();
      await pending;
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('does not apply when an unsaved title draft appears during generation', async () => {
    const finish = delayedResult();
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(args);
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    setTitleDraftDirty(noteId, dirtyOwner, true);
    await act(async () => {
      finish();
      await pending;
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('ignores a late response after navigation/unmount', async () => {
    const finish = delayedResult();
    const { result: hook, unmount } = renderHook(() => useRunSkill(noteId, null));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(args);
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    unmount();
    await act(async () => {
      finish();
      await pending;
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

it.each(['NO_TRANSCRIPT', 'NOTE_EMPTY'])('does not retain a recording failure for %s', async code => {
  useSkillRunActivityStore.setState({ runsByNote: new Map(), runningByNote: new Map() });
  useAutoEnhanceStore.getState().markWaiting('rec_silent');
  mocks.request.mockRejectedValue(new ApiError(code, 'Empty input', 400));
  const editor = { getJSON: () => ({ type: 'doc', content: [] }) } as unknown as Editor;
  const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
  await act(() => hook.current.run({ skillId: 'skl_enhance', skillName: 'Enhance', recordingId: 'rec_silent' }));
  expect(useAutoEnhanceStore.getState().failedRecordingId).toBeNull();
  expect(useAutoEnhanceStore.getState().waitingRecordingId).toBeNull();
  expect(useSkillRunActivityStore.getState().runsByNote.get(noteId)?.at(-1)?.status).toBe('skipped');
  expect(hook.current.running).toBe(false);
});
