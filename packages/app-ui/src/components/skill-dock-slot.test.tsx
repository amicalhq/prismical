// @vitest-environment jsdom
import type { SkillProposalHost } from './skill-proposal-host';
import type { Editor } from '@tiptap/react';
import * as React from 'react';
import { createWorkflowRuntime, type WorkflowRuntime } from '@prismical/app-workflow';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENHANCE_SKILL_ID } from '@prismical/app-contracts';
import { useAutoEnhanceStore } from '../../../app-client/src/notes/auto-enhance-store';
import { SkillDockSlot } from './skill-dock-slot';

const harness = vi.hoisted(() => ({
  workflow: undefined as WorkflowRuntime | undefined,
  hostProps: {} as React.ComponentProps<typeof SkillProposalHost>,
  hostMount: vi.fn(),
  privateEditor: { getJSON: () => ({ type: 'doc', content: [] }) },
  noteId: 'note_a',
  sessionKey: 'session_a',
  orgId: 'org_a',
  run: vi.fn(async () => {}),
  editor: { getJSON: () => ({ type: 'doc', content: [] }) },
}));
vi.mock('@prismical/editor-markdown', () => ({ tiptapJsonToMarkdown: () => '' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./skill-proposal-host', () => ({ SkillProposalHost: (props: React.ComponentProps<typeof SkillProposalHost>) => {
  harness.hostProps = props;
  const { hostKey, onEditor } = props;
  React.useEffect(() => {
    harness.hostMount();
    onEditor(hostKey, harness.privateEditor as unknown as Editor);
    return () => onEditor(hostKey, null);
  }, [hostKey, onEditor]);
  return null;
} }));
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
  const idle = { kind: 'idle' };
  const inert = { request: null, clear: () => {} };
  return {
    useAutoEnhanceStore,
    usePorts: () => ({ workflow: harness.workflow }),
    useWorkflowSnapshot: () => React.useSyncExternalStore(harness.workflow?.subscribe ?? (() => () => {}), harness.workflow?.getSnapshot ?? (() => idle)),
    useRecoverSkillResult: () => {},
    useSessionView: () => ({ activeSessionKey: harness.sessionKey, activeSub: harness.sessionKey }),
    activeOrgIdOf: () => harness.orgId,
    useSkillsList: () => ({ data: [{ id: ENHANCE_SKILL_ID, enabled: true }] }),
    useRunSkill: () => ({ run: harness.run }),
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
    harness.workflow = undefined;
    harness.hostMount.mockClear();
    harness.noteId = 'note_a';
    harness.sessionKey = 'session_a';
    harness.orgId = 'org_a';
    harness.run.mockReset().mockResolvedValue(undefined);
    useAutoEnhanceStore.getState().clear();
  });
  afterEach(cleanup);

  it('runs a shared queued enhancement on its private owner editor while another note is open', async () => {
    harness.workflow = createWorkflowRuntime();
    enqueue();
    harness.noteId = 'note_b';
    render(<SkillDockSlot />);
    await waitFor(() => expect(harness.run).toHaveBeenCalledOnce());
    expect(harness.hostProps.noteId).toBe('note_a');
    expect(harness.hostProps.sourceEditor).toBeNull();
    expect(harness.run).toHaveBeenCalledWith(expect.objectContaining({ recordingId: 'recording_a' }));
    await waitFor(() => expect(useAutoEnhanceStore.getState().requests).toEqual([]));
  });

  it('keeps the same private host while navigating during review and applying', () => {
    harness.workflow = createWorkflowRuntime();
    harness.workflow.dispatch({ type: 'runSkill', workflowId: 'wf', noteId: 'note_a', skillId: 'cleanup' });
    harness.workflow.dispatch({ type: 'proposalReady', workflowId: 'wf', attempt: 1, proposalId: 'proposal' });
    const view = render(<SkillDockSlot />);
    expect(harness.hostProps.sourceEditor).toBe(harness.editor);
    harness.noteId = 'note_b';
    view.rerender(<SkillDockSlot />);
    expect(harness.hostProps.noteId).toBe('note_a');
    expect(harness.hostProps.sourceEditor).toBeNull();
    act(() => { harness.workflow!.dispatch({ type: 'acceptProposal', workflowId: 'wf', proposalId: 'proposal' }); });
    expect(harness.hostMount).toHaveBeenCalledTimes(1);
    expect(harness.hostProps.noteId).toBe('note_a');
  });

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
