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

const mocks = vi.hoisted(() => ({
  store: null as unknown,
  request: vi.fn(),
  mutate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  capture: vi.fn(),
  defaults: vi.fn(),
  session: 'session-a',
  org: 'org-a',
}));
vi.mock('../sync/provider', () => ({ useSyncStore: () => mocks.store }));
vi.mock('../api/hooks/skill-runs', () => ({
  runSkillRequest: mocks.request,
  mutateTitleRun: mocks.mutate,
}));
vi.mock('../api/hooks/model-defaults', () => ({ ensureModelDefault: mocks.defaults }));
vi.mock('../ports-context', () => ({
  usePorts: () => ({ analytics: { capture: mocks.capture }, auth: {
    getSession: () => ({ activeSessionKey: mocks.session, activeOrgId: mocks.org }),
  } }),
  activeOrgIdOf: (view: { activeOrgId: string }) => view.activeOrgId,
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
  mocks.session = 'session-a';
  mocks.org = 'org-a';
  mocks.defaults.mockReset().mockResolvedValue({});
  notes$ = observable<
    Record<string, { title: string; titleSource: string; titleRevision: number }>
  >({
    [noteId]: { title: 'Original', titleSource: 'manual', titleRevision: 1 },
  });
  mocks.store = { notes$ };
  mocks.request.mockReset().mockResolvedValue(result);
  mocks.mutate.mockResolvedValue({
    noteId,
    title: 'Launch plan',
    titleSource: 'ai',
    titleRevision: 2,
  });
  useSkillDiffStore.setState({ candidatesByNote: new Map() });
  useSkillRunActivityStore.setState({ runsByNote: new Map(), runningByNote: new Map() });
  setTitleDraftDirty(noteId, dirtyOwner, false);
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
  const bodyEditor = { getJSON: () => ({ type: 'doc', content: [] }) } as unknown as Editor;
  const draft = {
    noteId, resultId: 'result-a', skillId: 'skl_enhance', skillName: 'Enhance',
    mode: 'replace-doc' as const, modelId: 'model-a', rawMarkdown: 'Original output',
    content: [{ type: 'paragraph' }], reasoning: null, refineInstruction: null, selectionText: null,
  };
  const refinement = {
    skillId: draft.skillId, skillName: draft.skillName, source: 'refine' as const,
    refineInstruction: 'Shorter', previousOutput: draft.rawMarkdown,
  };
  const stageDraft = (candidate = draft) => {
    useSkillDiffStore.getState().stage(candidate);
    const activity = useSkillRunActivityStore.getState();
    const id = activity.begin({ noteId, skillId: candidate.skillId, skillName: candidate.skillName, source: 'auto-enhance' });
    activity.finish(id, 'staged');
    return id;
  };

  it('stops a refinement displaced while waiting for model defaults', async () => {
    stageDraft();
    let release!: (value: object) => void;
    mocks.defaults.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { result: hook } = renderHook(() => useRunSkill(noteId, bodyEditor));
    let pending!: Promise<void>;
    act(() => { pending = hook.current.run(refinement); });
    await waitFor(() => expect(mocks.defaults).toHaveBeenCalled());
    const replacement = { ...draft, resultId: 'result-b', rawMarkdown: 'Replacement output' };
    let replacementFeed!: string;
    act(() => { replacementFeed = stageDraft(replacement); });
    await act(async () => { release({}); await pending; });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(replacement);
    expect(useSkillRunActivityStore.getState().runsByNote.get(noteId)?.find(run => run.id === replacementFeed)?.status).toBe('staged');
  });

  it.each(['fresh', 'refine'] as const)('preserves a newer candidate when an older %s run succeeds', async lane => {
    if (lane === 'refine') stageDraft();
    let release!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { result: hook } = renderHook(() => useRunSkill(noteId, bodyEditor));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.run(lane === 'refine' ? refinement : {
        skillId: draft.skillId, skillName: draft.skillName, source: 'wand', recordingId: 'recording-a',
      });
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    const requestFeed = useSkillRunActivityStore.getState().runsByNote.get(noteId)!.at(-1)!.id;
    const replacement = { ...draft, resultId: 'result-b', rawMarkdown: 'Newer output' };
    let replacementFeed!: string;
    act(() => { replacementFeed = stageDraft(replacement); });
    await act(async () => { release({ ...draft, rawMarkdown: 'Late output' }); await pending; });
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(replacement);
    const runs = useSkillRunActivityStore.getState().runsByNote.get(noteId)!;
    expect(runs.find(run => run.id === requestFeed)?.status).toBe('superseded');
    expect(runs.find(run => run.id === replacementFeed)?.status).toBe('staged');
  });

  it('does not retry fresh composer guidance over a recovered review', async () => {
    mocks.request.mockResolvedValue(draft).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result: hook } = renderHook(() => useRunSkill(noteId, bodyEditor));
    await act(() => hook.current.run({ skillId: draft.skillId, skillName: draft.skillName, source: 'composer', refineInstruction: 'Make it shorter' }));
    const retry = mocks.error.mock.calls[0]![1].action.onClick;
    expect(mocks.request.mock.calls[0]![1]).toMatchObject({ refineInstruction: 'Make it shorter', recoveryResultId: undefined });
    const replacement = { ...draft, resultId: 'result-b' };
    act(() => { stageDraft(replacement); });
    await act(async () => { retry(); });
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(replacement);
  });

  it('rejects a fresh body run while preserving an existing review', async () => {
    stageDraft();
    const { result: hook } = renderHook(() => useRunSkill(noteId, bodyEditor));
    await act(() => hook.current.run({ skillId: draft.skillId, skillName: draft.skillName, source: 'composer', refineInstruction: 'Fresh guidance' }));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(draft);
  });

  it('allows a title run while a body review is staged', async () => {
    stageDraft();
    const { result: hook } = renderHook(() => useRunSkill(noteId, null));
    await act(() => hook.current.run(args));
    expect(mocks.mutate).toHaveBeenCalledWith('apply', 'run_test');
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(draft);
  });

  it('keeps a title run when its note editor registers during generation', async () => {
    const finish = delayedResult();
    const { result: hook, rerender } = renderHook(
      ({ editor }) => useRunSkill(noteId, editor),
      { initialProps: { editor: null as Editor | null } },
    );
    let pending!: Promise<void>;
    act(() => { pending = hook.current.run(args); });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    rerender({ editor: bodyEditor });
    expect(mocks.request.mock.calls[0]![2].aborted).toBe(false);
    await act(async () => { finish(); await pending; });
    expect(mocks.mutate).toHaveBeenCalledWith('apply', 'run_test');
    expect(notes$[noteId]!.title.peek()).toBe('Launch plan');
  });

  it.each(['unregister', 'replace'] as const)('discards a late body response after its editor is %s', async change => {
    let release!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { result: hook, rerender } = renderHook(
      ({ editor }) => useRunSkill(noteId, editor),
      { initialProps: { editor: bodyEditor as Editor | null } },
    );
    let pending!: Promise<void>;
    act(() => { pending = hook.current.run({ skillId: draft.skillId, skillName: draft.skillName }); });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    rerender({ editor: change === 'unregister' ? null : { ...bodyEditor } as Editor });
    await act(async () => { release(draft); await pending; });
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBeUndefined();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('pins a review result for refinement and retries it while ownership is unchanged', async () => {
    stageDraft();
    mocks.request.mockResolvedValue({ ...draft, rawMarkdown: 'Refined output' }).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result: hook } = renderHook(() => useRunSkill(noteId, bodyEditor));
    await act(() => hook.current.run(refinement));
    await act(async () => { mocks.error.mock.calls[0]![1].action.onClick(); });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1]![1]).toMatchObject({ recoveryResultId: draft.resultId, previousOutput: draft.rawMarkdown });
    expect(useSkillDiffStore.getState().getCandidate(noteId)?.rawMarkdown).toBe('Refined output');
  });

  it('does not retry a refinement against a replacement with identical markdown', async () => {
    stageDraft();
    mocks.request.mockResolvedValue(draft).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result: hook } = renderHook(() => useRunSkill(noteId, bodyEditor));
    await act(() => hook.current.run(refinement));
    const retry = mocks.error.mock.calls[0]![1].action.onClick;
    const replacement = { ...draft, resultId: 'result-b' };
    act(() => { stageDraft(replacement); });
    await act(async () => { retry(); });
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(replacement);
  });

  it.each(['session', 'org', 'unmount', 'editor', 'note'] as const)('ignores a retained Retry after its %s changes', async change => {
    mocks.request.mockResolvedValue(draft).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result: hook, rerender, unmount } = renderHook(
      ({ note, editor }) => useRunSkill(note, editor),
      { initialProps: { note: noteId, editor: bodyEditor } },
    );
    await act(() => hook.current.run({ skillId: draft.skillId, skillName: draft.skillName, source: 'composer' }));
    const retry = mocks.error.mock.calls[0]![1].action.onClick;
    if (change === 'session' || change === 'org') mocks[change] = `${change}-b`;
    else if (change === 'unmount') unmount();
    else if (change === 'editor') rerender({ note: noteId, editor: { ...bodyEditor } as Editor });
    else rerender({ note: 'note-b', editor: bodyEditor });
    await act(async () => { retry(); });
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBeUndefined();
    expect(useSkillDiffStore.getState().getCandidate('note-b')).toBeUndefined();
  });

  it('clears a conflicting refinement candidate and settles its staged activity for recovery', async () => {
    const stagedFeed = stageDraft();
    mocks.request.mockRejectedValueOnce(new ApiError('SUGGESTION_CHANGED', 'Changed', 409));
    const { result: hook } = renderHook(() => useRunSkill(noteId, bodyEditor));
    await act(() => hook.current.run(refinement));
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBeUndefined();
    expect(useSkillRunActivityStore.getState().runsByNote.get(noteId)?.find(run => run.id === stagedFeed)?.status).toBe('superseded');
    expect(useSkillRunActivityStore.getState().runningByNote.has(noteId)).toBe(false);
  });

  it('preserves the refinement candidate and staged activity on a network failure', async () => {
    const stagedFeed = stageDraft();
    mocks.request.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result: hook } = renderHook(() => useRunSkill(noteId, bodyEditor));
    await act(() => hook.current.run(refinement));
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBe(draft);
    expect(useSkillRunActivityStore.getState().runsByNote.get(noteId)?.find(run => run.id === stagedFeed)?.status).toBe('staged');
  });

  it.each(['session', 'org'] as const)('does not stage a response after its %s changes before rerender', async field => {
    let release!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const editor = { getJSON: () => ({ type: 'doc', content: [] }) } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    let pending!: Promise<void>;
    act(() => { pending = hook.current.run({ skillId: 'skl_enhance', skillName: 'Enhance' }); });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    mocks[field] = `${field}-b`;
    await act(async () => {
      release({ skillId: 'skl_enhance', skillName: 'Enhance', resultId: 'saved-result', modelId: 'test-model', mode: 'replace-doc', rawMarkdown: 'Old owner output', reasoning: null });
      await pending;
    });
    expect(useSkillDiffStore.getState().getCandidate(noteId)).toBeUndefined();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('records a note-body suggestion only after it is staged', async () => {
    mocks.request.mockResolvedValue({ skillId: 'skl_enhance', skillName: 'Enhance', modelId: 'test-model', mode: 'replace-doc', rawMarkdown: 'Summary', reasoning: null });
    const editor = { getJSON: () => ({ type: 'doc', content: [] }) } as unknown as Editor;
    const { result: hook } = renderHook(() => useRunSkill(noteId, editor));
    await act(() => hook.current.run({ skillId: 'skl_enhance', skillName: 'Enhance' }));
    expect(useSkillDiffStore.getState().getCandidate(noteId)?.rawMarkdown).toBe('Summary');
    expect(useSkillDiffStore.getState().getCandidate(noteId)?.owner).toEqual({ sessionKey: 'session-a', orgId: 'org-a' });
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
