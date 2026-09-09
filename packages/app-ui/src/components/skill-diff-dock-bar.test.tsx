// @vitest-environment jsdom
import type { PropsWithChildren } from 'react';
import type { Editor } from '@tiptap/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSkillDiffStore } from '../../../app-client/src/notes/diff/skill-diff-store';
import { ApiError } from '../../../app-client/src/api/client';
import { SkillDiffDockBar } from './skill-diff-dock-bar';

const mock = vi.hoisted(() => ({
  resolve: vi.fn(),
  accept: vi.fn(),
  run: vi.fn(),
  clearDecorations: vi.fn(),
  resolveStaged: vi.fn(),
  walkthrough: vi.fn(),
  error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { error: mock.error, success: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../onboarding/context', () => ({ useWalkthroughEvent: () => mock.walkthrough }));
vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ children }: PropsWithChildren) => children,
  TooltipContent: () => null,
}));
vi.mock('@prismical/app-client', async () => {
  const { useSkillDiffStore } = await import('../../../app-client/src/notes/diff/skill-diff-store');
  return {
    ApiError,
    useSkillDiffStore,
    resolvePendingSkillResult: mock.resolve,
    clearDiffDecorations: mock.clearDecorations,
    resolveVerifiedRange: vi.fn(),
    useAcceptArtifact: () => ({ isPending: false, mutateAsync: mock.accept }),
    restoreLastSkillRun: vi.fn(),
    enhancedRecordingsKey: () => [],
    useRunSkill: () => ({ run: mock.run, cancel: vi.fn(), running: false }),
    useSkillRunActivityStore: { getState: () => ({ resolveStaged: mock.resolveStaged }) },
    useAutoEnhanceStore: { getState: () => ({ markFailed: vi.fn() }) },
  };
});

const candidate = {
  noteId: 'note-a',
  resultId: 'result-a',
  recordingId: 'recording-a',
  skillId: 'skill-a',
  skillName: 'Enhance',
  mode: 'replace-doc' as const,
  modelId: 'model-a',
  rawMarkdown: 'Saved result',
  content: [{ type: 'paragraph' }],
  reasoning: null,
  refineInstruction: null,
  selectionText: null,
};
const editor = {
  isDestroyed: false,
  getJSON: () => ({ type: 'doc', content: [] }),
  view: { dom: { firstElementChild: null } },
  commands: { setContent: vi.fn(() => true) },
} as unknown as Editor;
const fullBar = () => <SkillDiffDockBar editor={editor} noteId={candidate.noteId} />;
const pendingBar = () => <SkillDiffDockBar editor={null} noteId={candidate.noteId} />;
const undo = () => screen.getByRole('button', { name: 'skills.diff.undo' }) as HTMLButtonElement;
const staged = () => useSkillDiffStore.getState().getCandidate(candidate.noteId);

beforeEach(() => {
  vi.clearAllMocks();
  mock.resolve.mockReset().mockResolvedValue(undefined);
  useSkillDiffStore.setState({ candidatesByNote: new Map([[candidate.noteId, candidate]]) });
});
afterEach(cleanup);

describe('durable suggestion discard', () => {
  it.each([
    ['review', fullBar],
    ['waiting for editor', pendingBar],
  ] as const)('clears a stale %s candidate after a discard conflict so recovery can reload it', async (_name, bar) => {
    mock.resolve.mockRejectedValueOnce(new ApiError('SUGGESTION_CHANGED', 'Changed', 409));
    render(bar());
    fireEvent.click(undo());
    await waitFor(() => expect(mock.error).toHaveBeenCalledOnce());
    expect(staged()).toBeUndefined();
    expect(mock.resolveStaged).toHaveBeenCalledExactlyOnceWith(candidate.noteId, 'superseded');
  });

  it.each([
    ['Undo', () => undo(), mock.resolve],
    ['Keep', () => screen.getByRole('button', { name: 'skills.diff.keep' }), mock.accept],
  ] as const)('preserves a replacement candidate after an older %s conflict', async (_name, button, request) => {
    let reject!: (error: unknown) => void;
    request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(fullBar());
    fireEvent.click(button());
    const replacement = { ...candidate, rawMarkdown: 'Newer saved output' };
    act(() => useSkillDiffStore.getState().stage(replacement));
    await act(async () => reject(new ApiError('SUGGESTION_CHANGED', 'Changed', 409)));
    expect(staged()).toBe(replacement);
    expect(mock.clearDecorations).not.toHaveBeenCalled();
    expect(mock.resolveStaged).not.toHaveBeenCalled();
  });

  it('clears a stale Keep candidate but preserves a draft after a network failure', async () => {
    mock.accept.mockRejectedValueOnce(new Error('offline'));
    render(fullBar());
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    await waitFor(() => expect(mock.error).toHaveBeenCalledTimes(1));
    expect(staged()).toBe(candidate);
    mock.accept.mockRejectedValueOnce(new ApiError('SUGGESTION_CHANGED', 'Changed', 409));
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    await waitFor(() => expect(mock.error).toHaveBeenCalledTimes(2));
    expect(staged()).toBeUndefined();
    expect(mock.resolveStaged).toHaveBeenCalledExactlyOnceWith(candidate.noteId, 'superseded');
  });

  it.each([
    ['missing editor', null],
    ['replacement editor', { ...editor, commands: { setContent: vi.fn(() => true) } } as unknown as Editor],
  ] as const)('does not apply a pending Keep to its detached editor after a %s commits', async (_name, nextEditor) => {
    let release!: (value: unknown) => void;
    mock.accept.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const view = render(fullBar());
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    view.rerender(<SkillDiffDockBar editor={nextEditor} noteId={candidate.noteId} />);
    await act(async () => release({ artifactId: 'artifact-a', version: 1, generatedAt: 'now' }));
    expect(staged()).toBe(candidate);
    expect(editor.commands.setContent).not.toHaveBeenCalled();
    expect(mock.resolveStaged).not.toHaveBeenCalled();
  });

  it('keeps Undo in flight when the editor becomes available', async () => {
    let release!: () => void;
    mock.resolve.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const view = render(pendingBar());
    fireEvent.click(undo());
    view.rerender(fullBar());
    expect(undo().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'skills.diff.keep' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    expect(staged()).toBeUndefined();
  });

  it('keeps the candidate for retry if its editor unmounts while Keep is pending', async () => {
    let release!: (value: unknown) => void;
    mock.accept.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const view = render(fullBar());
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    view.unmount();
    await act(async () => release({ artifactId: 'artifact-a', version: 1, generatedAt: 'now' }));
    expect(staged()).toBe(candidate);
    expect(editor.commands.setContent).not.toHaveBeenCalled();
  });

  it('does not apply an old Keep response over a replacement candidate', async () => {
    let release!: (value: unknown) => void;
    mock.accept.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    render(fullBar());
    fireEvent.click(screen.getByRole('button', { name: 'skills.diff.keep' }));
    const replacement = { ...candidate, rawMarkdown: 'Newer output' };
    act(() => useSkillDiffStore.getState().stage(replacement));
    await act(async () => release({ artifactId: 'artifact-a', version: 1, generatedAt: 'now' }));
    expect(staged()).toBe(replacement);
    expect(editor.commands.setContent).not.toHaveBeenCalled();
    expect(mock.resolveStaged).not.toHaveBeenCalled();
  });

  it('blocks Keep, refine, and repeated Undo until discard finishes', async () => {
    let release!: () => void;
    mock.resolve.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );
    render(fullBar());
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Shorten it' } });
    const refine = screen.getByRole('button', {
      name: 'skills.diff.submitRefinement',
    }) as HTMLButtonElement;
    const keep = screen.getByRole('button', { name: 'skills.diff.keep' }) as HTMLButtonElement;
    fireEvent.click(undo());
    expect(undo().disabled).toBe(true);
    expect(keep.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(refine.disabled).toBe(true);
    fireEvent.click(undo());
    fireEvent.click(keep);
    fireEvent.click(refine);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mock.resolve).toHaveBeenCalledExactlyOnceWith(candidate.noteId, candidate.resultId, candidate.rawMarkdown);
    expect(mock.accept).not.toHaveBeenCalled();
    expect(mock.run).not.toHaveBeenCalled();
    expect(staged()).toBe(candidate);
    await act(async () => release());
    expect(staged()).toBeUndefined();
    expect(mock.resolveStaged).toHaveBeenCalledExactlyOnceWith(candidate.noteId, 'undone');
  });

  it.each([
    ['review', fullBar],
    ['waiting for editor', pendingBar],
  ] as const)('keeps a %s candidate on failure and allows a durable retry', async (_name, bar) => {
    mock.resolve.mockRejectedValueOnce(new Error('offline'));
    render(bar());
    fireEvent.click(undo());
    await waitFor(() => expect(mock.error).toHaveBeenCalledOnce());
    expect(staged()).toBe(candidate);
    expect(undo().disabled).toBe(false);
    expect(mock.resolveStaged).not.toHaveBeenCalled();
    fireEvent.click(undo());
    await waitFor(() => expect(staged()).toBeUndefined());
    expect(mock.resolve).toHaveBeenCalledTimes(2);
  });

  it('does not clear a replacement candidate when an older discard finishes', async () => {
    let release!: () => void;
    mock.resolve.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );
    render(fullBar());
    fireEvent.click(undo());
    const replacement = { ...candidate, resultId: 'result-b', rawMarkdown: 'New result' };
    act(() => useSkillDiffStore.getState().stage(replacement));
    await act(async () => release());
    expect(staged()).toBe(replacement);
    expect(mock.clearDecorations).not.toHaveBeenCalled();
    expect(mock.resolveStaged).not.toHaveBeenCalled();
    expect(mock.walkthrough).not.toHaveBeenCalled();
  });

  it('persists Undo while the editor is unavailable', async () => {
    let release!: () => void;
    mock.resolve.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );
    render(pendingBar());
    fireEvent.click(undo());
    expect(undo().disabled).toBe(true);
    expect(mock.resolve).toHaveBeenCalledExactlyOnceWith(candidate.noteId, candidate.resultId, candidate.rawMarkdown);
    expect(staged()).toBe(candidate);
    await act(async () => release());
    expect(staged()).toBeUndefined();
    expect(mock.clearDecorations).not.toHaveBeenCalled();
  });
});
