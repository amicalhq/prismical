import { describe, expect, it } from 'vitest';
import { canRunSkill, canStartRecording, idleWorkflow } from './machine';
import { createWorkflowRuntime } from './runtime';
import type { WorkflowCommand, WorkflowScope, WorkflowState } from './types';

const start = { type: 'startRecording', workflowId: 'recording-workflow', noteId: 'note-a' } as const;
const run = { type: 'runSkill', workflowId: 'skill-workflow', noteId: 'note-b', skillId: 'cleanup' } as const;

function scope(state: WorkflowState): WorkflowScope {
  if (state.kind === 'idle') throw new Error('Expected an active workflow');
  return { workflowId: state.workflowId, attempt: state.attempt };
}

describe('recording and skill workflow', () => {
  it('admits exactly one simultaneous start and keeps both guards closed through review and applying', async () => {
    const runtime = createWorkflowRuntime();
    const [skill, recording] = await Promise.all([runtime.request(run), runtime.request(start)]);
    expect(skill.accepted).toBe(true);
    expect(recording.accepted).toBe(false);
    runtime.dispatch({ type: 'proposalReady', ...scope(runtime.getSnapshot()), proposalId: 'proposal' });
    expect(canStartRecording(runtime.getSnapshot())).toBe(false);
    expect(canRunSkill(runtime.getSnapshot())).toBe(false);
    expect(runtime.dispatch({ type: 'acceptProposal', workflowId: run.workflowId, proposalId: 'proposal' }).accepted).toBe(true);
    expect(runtime.dispatch({ type: 'acceptProposal', workflowId: run.workflowId, proposalId: 'proposal' }).accepted).toBe(false);
    expect(runtime.dispatch(start).accepted).toBe(false);
    runtime.dispatch({ type: 'applySucceeded', ...scope(runtime.getSnapshot()) });
    expect(runtime.getSnapshot()).toEqual(idleWorkflow);
  });

  it('keeps the target and recording ownership through drain, finalization and auto-enhancement', () => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch(start);
    runtime.dispatch({ type: 'captureReady', ...scope(runtime.getSnapshot()), recordingId: 'audio' });
    runtime.dispatch({ type: 'stopRecording', workflowId: start.workflowId });
    expect(runtime.dispatch(run).accepted).toBe(false);
    const drainScope = scope(runtime.getSnapshot());
    expect(runtime.dispatch({ type: 'finalizationSucceeded', ...drainScope }).accepted).toBe(false);
    runtime.dispatch({ type: 'inputDrained', ...drainScope });
    expect(runtime.dispatch({ type: 'finalizationSucceeded', ...drainScope }).accepted).toBe(false);
    runtime.dispatch({ type: 'finalizationSucceeded', ...scope(runtime.getSnapshot()), autoSkill: { skillId: 'enhance' } });
    expect(runtime.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'running', workflowId: start.workflowId, noteId: 'note-a', recordingId: 'audio', skillId: 'enhance' });
    expect(runtime.dispatch(run).accepted).toBe(false);
    expect(runtime.dispatch(start).accepted).toBe(false);
  });

  it('fences readiness after Stop while permissions were pending and ignores a previous recording', () => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch(start);
    const opening = scope(runtime.getSnapshot());
    runtime.dispatch({ type: 'stopRecording', workflowId: start.workflowId });
    expect(runtime.dispatch({ type: 'captureReady', ...opening, recordingId: 'late-audio' }).accepted).toBe(false);
    runtime.dispatch({ type: 'recordingFailed', ...scope(runtime.getSnapshot()), captureClosed: true });
    runtime.dispatch({ ...start, workflowId: 'new-recording' });
    expect(runtime.dispatch({ type: 'recordingFailed', ...opening, captureClosed: true }).accepted).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({ workflowId: 'new-recording', phase: 'starting' });
  });

  it('commits pause/resume only after confirmation and rejects an earlier pause attempt', () => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch(start);
    runtime.dispatch({ type: 'captureReady', ...scope(runtime.getSnapshot()), recordingId: 'audio' });
    runtime.dispatch({ type: 'pauseRecording', workflowId: start.workflowId });
    const pause = scope(runtime.getSnapshot());
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'capturing' });
    runtime.dispatch({ type: 'capturePaused', ...pause });
    runtime.dispatch({ type: 'resumeRecording', workflowId: start.workflowId });
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'paused' });
    runtime.dispatch({ type: 'captureResumed', ...scope(runtime.getSnapshot()) });
    expect(runtime.dispatch({ type: 'capturePaused', ...pause }).accepted).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'capturing' });
  });

  it('preserves a proposal after refine cancellation and apply failure, fencing previous attempts', () => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch(run);
    runtime.dispatch({ type: 'proposalReady', ...scope(runtime.getSnapshot()), proposalId: 'original' });
    runtime.dispatch({ type: 'refineSkill', workflowId: run.workflowId, proposalId: 'original' });
    const refinement = scope(runtime.getSnapshot());
    runtime.dispatch({ type: 'skillCancelled', ...refinement });
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'original' });
    runtime.dispatch({ type: 'acceptProposal', workflowId: run.workflowId, proposalId: 'original' });
    const firstApply = scope(runtime.getSnapshot());
    runtime.dispatch({ type: 'applyFailed', ...firstApply, error: 'target-changed' });
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'original', error: 'target-changed' });
    runtime.dispatch({ type: 'acceptProposal', workflowId: run.workflowId, proposalId: 'original' });
    expect(runtime.dispatch({ type: 'applySucceeded', ...firstApply }).accepted).toBe(false);
    expect(runtime.dispatch({ type: 'proposalReady', ...refinement, proposalId: 'late' }).accepted).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'applying', proposalId: 'original' });
  });

  it('declines atomically and does not allow an old proposal to complete a new workflow', () => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch(run);
    const previous = scope(runtime.getSnapshot());
    runtime.dispatch({ type: 'proposalReady', ...previous, proposalId: 'proposal' });
    expect(runtime.dispatch({ type: 'declineProposal', workflowId: run.workflowId, proposalId: 'proposal' }).state).toEqual(idleWorkflow);
    expect(runtime.dispatch(start).accepted).toBe(true);
    expect(runtime.dispatch({ type: 'applySucceeded', ...previous }).accepted).toBe(false);
  });

  it('rejects review commands from an older proposal in the same workflow', () => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch(run);
    runtime.dispatch({ type: 'proposalReady', ...scope(runtime.getSnapshot()), proposalId: 'old' });
    runtime.dispatch({ type: 'refineSkill', workflowId: run.workflowId, proposalId: 'old' });
    runtime.dispatch({ type: 'proposalReady', ...scope(runtime.getSnapshot()), proposalId: 'new' });
    expect(runtime.dispatch({ type: 'acceptProposal', workflowId: run.workflowId, proposalId: 'old' }).accepted).toBe(false);
    expect(runtime.dispatch({ type: 'declineProposal', workflowId: run.workflowId, proposalId: 'old' }).accepted).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'review', proposalId: 'new' });
  });
});

describe('portable runtime', () => {
  it('commits admission before an adapter can submit a competing command', () => {
    let rejected: boolean | undefined;
    const runtime = createWorkflowRuntime({ execute: () => { rejected = !runtime.dispatch(run).accepted; } });
    runtime.dispatch(start);
    expect(rejected).toBe(true);
  });

  it('serializes synchronous adapter completions without recursive effect execution', () => {
    const commands: string[] = [];
    let executing = false;
    const runtime = createWorkflowRuntime({ execute(command, report) {
      expect(executing).toBe(false);
      executing = true;
      commands.push(command.type);
      if (command.type === 'stopCapture') report({ type: 'inputDrained', ...scope(command.scope) });
      if (command.type === 'finalizeRecording') report({ type: 'finalizationSucceeded', ...scope(command.scope) });
      executing = false;
    } });
    runtime.dispatch(start);
    runtime.dispatch({ type: 'stopRecording', workflowId: start.workflowId });
    expect(commands).toEqual(['startCapture', 'stopCapture', 'finalizeRecording']);
    expect(runtime.getSnapshot()).toEqual(idleWorkflow);
  });

  it('executes acquisition before a subscriber can request Stop, then executes cleanup', () => {
    const commands: WorkflowCommand[] = [];
    const runtime = createWorkflowRuntime({ execute(command) { commands.push(command); } });
    const unsubscribe = runtime.subscribe(() => {
      if (runtime.getSnapshot().kind === 'recording') {
        unsubscribe();
        runtime.dispatch({ type: 'stopRecording', workflowId: start.workflowId });
      }
    });
    runtime.dispatch(start);
    expect(commands.map(command => command.type)).toEqual(['startCapture', 'stopCapture']);
  });

  it('uses injected scheduling and ignores expired facts from retired work', () => {
    let fire: (() => void) | undefined;
    const runtime = createWorkflowRuntime({ timers: { schedule(_delay, callback) {
      fire = callback;
      return () => { fire = undefined; };
    } } });
    runtime.dispatch(run);
    runtime.schedule({ type: 'skillFailed', ...scope(runtime.getSnapshot()) }, 100);
    runtime.dispatch({ type: 'skillNoChange', ...scope(runtime.getSnapshot()) });
    runtime.dispatch(start);
    fire?.();
    expect(runtime.getSnapshot()).toMatchObject({ kind: 'recording', workflowId: start.workflowId });
  });
});
