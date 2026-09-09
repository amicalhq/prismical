import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '@prismical/app-contracts';
import { createWorkflowRuntime } from '@prismical/app-workflow';
import {
  useSkillDiffStore,
  useAutoEnhanceStore,
  useAskSkillRunStore,
  useInlineRunStore,
} from '@prismical/app-client';
import { bindDesktopWorkflowLifecycle } from '../../src/renderer/main/app/ports/workflow-lifecycle';

afterEach(() => {
  useSkillDiffStore.setState({ candidatesByNote: new Map() });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  let view: SessionView = {
    state: 'signed-in',
    activeSub: 'user_1',
    activeSessionKey: 'session_1',
    accounts: [
      { sub: 'user_1', sessionKey: 'session_1', email: 'user@example.com', activeOrgId: 'org_1' },
    ],
  };
  let listener: ((next: SessionView) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const workflow = createWorkflowRuntime();
  workflow.dispatch({ type: 'runSkill', workflowId: 'wf_1', noteId: 'note_1', skillId: 'skill_1' });
  workflow.dispatch({
    type: 'proposalReady',
    workflowId: 'wf_1',
    attempt: 1,
    proposalId: 'proposal_1',
  });
  useSkillDiffStore.getState().stage({
    workflowId: 'wf_1',
    proposalId: 'proposal_1',
    noteId: 'note_1',
    skillId: 'skill_1',
    skillName: 'Enhance',
    mode: 'replace-doc',
    modelId: 'model_1',
    reasoning: null,
    refineInstruction: null,
    selectionText: null,
    content: [],
    rawMarkdown: 'Draft',
  });
  const clears = [useAutoEnhanceStore, useAskSkillRunStore, useInlineRunStore].map(store =>
    vi.spyOn(store.getState(), 'clear')
  );
  const events = new EventTarget();
  vi.stubGlobal('window', events);
  const dispose = vi.fn(() => workflow.dispose());
  bindDesktopWorkflowLifecycle({
    auth: {
      getSession: () => view,
      onSessionChanged: next => {
        listener = next;
        return unsubscribe;
      },
    },
    workflow,
    dispose,
  });
  return {
    workflow,
    clears,
    events,
    dispose,
    unsubscribe,
    update(patch: Partial<SessionView>) {
      view = { ...view, ...patch };
      listener?.(view);
    },
  };
}

describe('desktop workflow lifecycle', () => {
  it.each([
    { activeSessionKey: 'session_2' },
    {
      accounts: [
        { sub: 'user_1', sessionKey: 'session_1', email: 'user@example.com', activeOrgId: 'org_2' },
      ],
    },
    {
      state: 'signed-out' as const,
      activeSub: undefined,
      activeSessionKey: undefined,
      accounts: [],
    },
  ])('closes the owned proposal and queued runs after a scope change: %j', patch => {
    const { workflow, update, clears } = setup();
    update(patch);
    expect(workflow.getSnapshot()).toEqual({ kind: 'idle' });
    expect(useSkillDiffStore.getState().getCandidate('note_1')).toBeUndefined();
    for (const clear of clears) expect(clear).toHaveBeenCalledOnce();
  });

  it('keeps review through refresh and same-owner updates, then detects a different owner', () => {
    const { workflow, update, clears } = setup();
    update({ state: 'refreshing', activeSessionKey: undefined, accounts: [] });
    update({
      state: 'signed-in',
      activeSessionKey: 'session_1',
      accounts: [
        {
          sub: 'user_1',
          sessionKey: 'session_1',
          email: 'updated@example.com',
          activeOrgId: 'org_1',
        },
      ],
    });
    expect(workflow.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'review' });
    expect(useSkillDiffStore.getState().getCandidate('note_1')).toBeDefined();
    for (const clear of clears) expect(clear).not.toHaveBeenCalled();
    update({ activeSessionKey: 'session_2' });
    expect(workflow.getSnapshot()).toEqual({ kind: 'idle' });
    for (const clear of clears) expect(clear).toHaveBeenCalledOnce();
  });

  it('does not clear a replacement proposal owned by another workflow', () => {
    const { update } = setup();
    const proposal = useSkillDiffStore.getState().getCandidate('note_1')!;
    useSkillDiffStore.getState().stage({ ...proposal, workflowId: 'wf_replacement' });
    update({ activeSessionKey: 'session_2' });
    expect(useSkillDiffStore.getState().getCandidate('note_1')?.workflowId).toBe('wf_replacement');
  });

  it('unsubscribes and disposes ports once when the renderer closes', () => {
    const { events, unsubscribe, dispose, update, clears } = setup();
    events.dispatchEvent(new Event('pagehide'));
    events.dispatchEvent(new Event('pagehide'));
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    update({ activeSessionKey: 'session_2' });
    for (const clear of clears) expect(clear).not.toHaveBeenCalled();
  });
});
