// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENHANCE_SKILL_ID } from '@prismical/app-contracts';
import { useAutoEnhanceStore } from '../../../app-client/src/notes/auto-enhance-store';
import { SkillDockSlot } from './skill-dock-slot';

const harness = vi.hoisted(() => ({
  noteId: 'note_a',
  sessionKey: 'session_a',
  orgId: 'org_a',
  run: vi.fn(async () => {}),
  editor: { getJSON: () => ({ type: 'doc', content: [] }) },
}));
vi.mock('@prismical/editor-markdown', () => ({ tiptapJsonToMarkdown: () => '' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./skill-diff-dock-bar', () => ({ SkillDiffDockBar: () => null }));
vi.mock('../lib/skill-presentation', () => ({ skillDisplayName: () => 'Enhance' }));
vi.mock('../shell/current-note-context', () => ({
  useCurrentNote: () => ({ currentNote: { noteId: harness.noteId } }),
}));
vi.mock('../shell/current-editor-context', () => ({
  useCurrentNoteEditor: () => ({ editor: harness.editor, editorNoteId: harness.noteId }),
}));
vi.mock('@prismical/app-client', async () => {
  const { useAutoEnhanceStore } = await import('../../../app-client/src/notes/auto-enhance-store');
  const inert = { request: null, clear: () => {} };
  return {
    useAutoEnhanceStore,
    useSessionView: () => ({ activeSessionKey: harness.sessionKey, activeSub: harness.sessionKey }),
    activeOrgIdOf: () => harness.orgId,
    useSkillsList: () => ({ data: [{ id: ENHANCE_SKILL_ID, enabled: true }] }),
    useRunSkill: () => ({ run: harness.run }),
    useRecoverSkillResult: vi.fn(),
    useSkillDiffStore: (select: (value: unknown) => unknown) =>
      select({ candidatesByNote: new Map() }),
    useInlineRunStore: (select: (value: unknown) => unknown) => select(inert),
    useAskSkillRunStore: (select: (value: unknown) => unknown) => select(inert),
  };
});

function enqueue(recordingId = 'recording_a', noteId = 'note_a') {
  useAutoEnhanceStore.getState().requestAutoEnhance({
    recordingId,
    noteId,
    source: 'auto-enhance',
    ownerSessionKey: 'session_a',
    ownerOrgId: 'org_a',
  });
}

describe('recording enhancement ownership', () => {
  beforeEach(() => {
    harness.noteId = 'note_a';
    harness.sessionKey = 'session_a';
    harness.orgId = 'org_a';
    harness.run.mockReset().mockResolvedValue(undefined);
    useAutoEnhanceStore.getState().clear();
  });
  afterEach(cleanup);

  it('retains requests while another note is open, then runs them on their owner note', async () => {
    enqueue();
    harness.noteId = 'note_b';
    const view = render(<SkillDockSlot />);
    expect(harness.run).not.toHaveBeenCalled();
    expect(useAutoEnhanceStore.getState().requests).toHaveLength(1);
    harness.noteId = 'note_a';
    view.rerender(<SkillDockSlot />);
    await waitFor(() => expect(harness.run).toHaveBeenCalledOnce());
    await waitFor(() => expect(useAutoEnhanceStore.getState().requests).toEqual([]));
  });

  it('does not consume a different account or organization request', async () => {
    enqueue();
    harness.sessionKey = 'session_b';
    const view = render(<SkillDockSlot />);
    expect(harness.run).not.toHaveBeenCalled();
    harness.sessionKey = 'session_a';
    harness.orgId = 'org_b';
    view.rerender(<SkillDockSlot />);
    expect(harness.run).not.toHaveBeenCalled();
    expect(useAutoEnhanceStore.getState().requests).toHaveLength(1);
    harness.orgId = 'org_a';
    view.rerender(<SkillDockSlot />);
    await waitFor(() => expect(harness.run).toHaveBeenCalledOnce());
  });

  it('retains an interrupted run when the owner editor unmounts', async () => {
    let finish!: () => void;
    harness.run.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    enqueue();
    const view = render(<SkillDockSlot />);
    expect(harness.run).toHaveBeenCalledOnce();
    harness.noteId = 'note_b';
    view.rerender(<SkillDockSlot />);
    await act(async () => {
      finish();
    });
    expect(useAutoEnhanceStore.getState().requests).toHaveLength(1);
    harness.noteId = 'note_a';
    view.rerender(<SkillDockSlot />);
    await waitFor(() => expect(harness.run).toHaveBeenCalledTimes(2));
  });

  it('preserves two recordings and consumes only the completed one', async () => {
    let finish!: () => void;
    harness.run.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    enqueue('recording_a');
    enqueue('recording_b', 'note_b');
    render(<SkillDockSlot />);
    expect(harness.run).toHaveBeenCalledOnce();
    expect(useAutoEnhanceStore.getState().requests).toHaveLength(2);
    await act(async () => {
      finish();
    });
    expect(useAutoEnhanceStore.getState().requests.map(item => item.recordingId)).toEqual([
      'recording_b',
    ]);
  });
});
