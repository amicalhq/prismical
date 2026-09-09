import { useSkillDiffStore } from '@prismical/app-client';
import type { AuthPort } from '@prismical/app-contracts';
import { createWorkflowRuntime } from '@prismical/app-workflow';
import { afterEach, expect, it, vi } from 'vitest';
import { reserveNativeSkillWorkflow } from '../../src/renderer/main/app/ports/native-skill-reservation';

vi.mock('@prismical/app-client', async importOriginal => ({
  activeOrgIdOf: () => 'org_1',
  useSkillDiffStore: (await importOriginal<typeof import('@prismical/app-client')>()).useSkillDiffStore,
}));
afterEach(() => vi.unstubAllGlobals());

const auth = { getSession: () => ({ activeSub: 'user_1', accounts: [] }) } as unknown as AuthPort;

it('holds native admission across skill running, review, and applying, then releases', async () => {
  const setSkillWorkflow = vi.fn(async () => true);
  vi.stubGlobal('window', { desktop: { recording: { setSkillWorkflow } } });
  const workflow = createWorkflowRuntime();
  const dispose = reserveNativeSkillWorkflow(auth, workflow);
  await workflow.request({ type: 'runSkill', workflowId: 'workflow_1', noteId: 'note_1', skillId: 'enhance' });
  workflow.dispatch({ type: 'proposalReady', workflowId: 'workflow_1', attempt: 1, proposalId: 'proposal_1' });
  await workflow.request({ type: 'acceptProposal', workflowId: 'workflow_1', proposalId: 'proposal_1' });
  expect(setSkillWorkflow).toHaveBeenCalledTimes(1);
  expect(setSkillWorkflow).toHaveBeenCalledWith({ active: true, ownerSessionKey: 'user_1', ownerOrgId: 'org_1' });
  workflow.dispatch({ type: 'applySucceeded', workflowId: 'workflow_1', attempt: 2 });
  expect(setSkillWorkflow).toHaveBeenLastCalledWith({ active: false, ownerSessionKey: 'user_1', ownerOrgId: 'org_1' });
  dispose();
  expect(setSkillWorkflow).toHaveBeenCalledTimes(2);
});

it('releases a reservation when its renderer disposes', async () => {
  const setSkillWorkflow = vi.fn(async () => true);
  vi.stubGlobal('window', { desktop: { recording: { setSkillWorkflow } } });
  const workflow = createWorkflowRuntime();
  const dispose = reserveNativeSkillWorkflow(auth, workflow);
  await workflow.request({ type: 'runSkill', workflowId: 'workflow_1', noteId: 'note_1', skillId: 'enhance' });
  dispose();
  expect(setSkillWorkflow).toHaveBeenLastCalledWith({ active: false, ownerSessionKey: 'user_1', ownerOrgId: 'org_1' });
});

it('retires a skill whose owner no longer matches main', async () => {
  const setSkillWorkflow = vi.fn(async () => false);
  vi.stubGlobal('window', { desktop: { recording: { setSkillWorkflow } } });
  const workflow = createWorkflowRuntime();
  const dispose = reserveNativeSkillWorkflow(auth, workflow);
  await workflow.request({ type: 'runSkill', workflowId: 'workflow_1', noteId: 'note_1', skillId: 'enhance' });
  await vi.waitFor(() => expect(workflow.getSnapshot()).toEqual({ kind: 'idle' }));
  dispose();
});

it('retires the latest skill attempt when native admission rejects a delayed reservation', async () => {
  let reject!: (accepted: boolean) => void;
  const setSkillWorkflow = vi.fn(() => new Promise<boolean>(done => { reject = done; }));
  vi.stubGlobal('window', { desktop: { recording: { setSkillWorkflow } } });
  const workflow = createWorkflowRuntime();
  const dispose = reserveNativeSkillWorkflow(auth, workflow);
  workflow.dispatch({ type: 'runSkill', workflowId: 'workflow_1', noteId: 'note_1', skillId: 'enhance' });
  workflow.dispatch({ type: 'proposalReady', workflowId: 'workflow_1', attempt: 1, proposalId: 'proposal_1' });
  workflow.dispatch({ type: 'acceptProposal', workflowId: 'workflow_1', proposalId: 'proposal_1' });
  useSkillDiffStore.getState().stage({
    workflowId: 'workflow_1', proposalId: 'proposal_1', noteId: 'note_1', skillId: 'enhance',
    skillName: 'Enhance', mode: 'replace-doc', content: [], rawMarkdown: 'Saved output',
    modelId: 'model', reasoning: null, refineInstruction: null, selectionText: null,
  });
  reject(false);
  await vi.waitFor(() => expect(workflow.getSnapshot()).toEqual({ kind: 'idle' }));
  expect(useSkillDiffStore.getState().getCandidate('note_1')).toBeUndefined();
  dispose();
});
