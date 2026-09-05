// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { observable } from '@legendapp/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import { setTitleDraftDirty } from './title-drafts';
import { useSkillDiffStore } from './diff/skill-diff-store';

const mocks = vi.hoisted(() => ({
  store: null as unknown,
  request: vi.fn(),
  mutate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('../sync/provider', () => ({ useSyncStore: () => mocks.store }));
vi.mock('../api/hooks/skill-runs', () => ({
  runSkillRequest: mocks.request,
  mutateTitleRun: mocks.mutate,
}));
vi.mock('../api/hooks/model-defaults', () => ({ ensureModelDefault: async () => ({}) }));
vi.mock('../ports-context', () => ({
  usePorts: () => ({ analytics: { capture: mocks.capture } }),
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
