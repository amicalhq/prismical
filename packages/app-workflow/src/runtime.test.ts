import { describe, expect, it, vi } from 'vitest';
import { createWorkflowRuntime } from './runtime';
import type { WorkflowFact } from './types';

describe('workflow owner retirement', () => {
  it.each(['running', 'review', 'applying'] as const)('closes a lost skill host in %s and fences its late result', phase => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch({ type: 'runSkill', workflowId: 'old', noteId: 'note', skillId: 'cleanup' });
    if (phase !== 'running') runtime.dispatch({ type: 'proposalReady', workflowId: 'old', attempt: 1, proposalId: 'proposal' });
    if (phase === 'applying') runtime.dispatch({ type: 'acceptProposal', workflowId: 'old', proposalId: 'proposal' });
    const current = runtime.getSnapshot();
    expect(current.kind).toBe('skill');
    if (current.kind !== 'skill') throw new Error('Expected a skill');
    expect(runtime.dispatch({ type: 'skillHostClosed', workflowId: current.workflowId, attempt: current.attempt }).accepted).toBe(true);
    expect(runtime.dispatch({ type: 'runSkill', workflowId: 'new', noteId: 'another-note', skillId: 'cleanup' }).accepted).toBe(true);
    expect(runtime.dispatch({ type: 'applySucceeded', workflowId: current.workflowId, attempt: current.attempt }).accepted).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({ kind: 'skill', workflowId: 'new' });
  });

  it('does not let a stale skill host-close event end recording', () => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch({ type: 'startRecording', workflowId: 'recording', noteId: 'note' });
    expect(runtime.dispatch({ type: 'skillHostClosed', workflowId: 'recording', attempt: 1 }).accepted).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({ kind: 'recording' });
  });

  it('rejects late adapter completion and new commands after disposal', async () => {
    let report!: (fact: WorkflowFact) => unknown;
    const execute = vi.fn((_command, callback) => { report = callback; });
    const runtime = createWorkflowRuntime({ execute });
    runtime.dispatch({ type: 'runSkill', workflowId: 'old', noteId: 'note', skillId: 'cleanup' });
    runtime.dispose();
    expect(report({ type: 'proposalReady', workflowId: 'old', attempt: 1, proposalId: 'late' }))
      .toEqual({ accepted: false, state: { kind: 'idle' } });
    expect(await runtime.request({ type: 'startRecording', workflowId: 'new', noteId: 'note' }))
      .toEqual({ accepted: false, state: { kind: 'idle' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('cancels pending deadlines and cannot schedule after disposal', () => {
    const cancel = vi.fn();
    let expire!: () => void;
    const schedule = vi.fn((_delay, callback) => { expire = callback; return cancel; });
    const runtime = createWorkflowRuntime({ timers: { schedule } });
    runtime.dispatch({ type: 'runSkill', workflowId: 'old', noteId: 'note', skillId: 'cleanup' });
    const fact = { type: 'skillFailed', workflowId: 'old', attempt: 1 } as const;
    runtime.schedule(fact, 100);
    runtime.dispose();
    runtime.dispose();
    runtime.schedule(fact, 100);
    expire();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toEqual({ kind: 'idle' });
  });

  it('notifies existing subscribers of retirement and leaves new subscriptions inert', () => {
    const runtime = createWorkflowRuntime();
    runtime.dispatch({ type: 'runSkill', workflowId: 'old', noteId: 'note', skillId: 'cleanup' });
    const listener = vi.fn(() => expect(runtime.getSnapshot()).toEqual({ kind: 'idle' }));
    runtime.subscribe(listener);
    runtime.dispose();
    runtime.subscribe(listener);
    runtime.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not execute queued commands after disposal during an effect', () => {
    const commands: string[] = [];
    const runtime = createWorkflowRuntime({ execute(command, report) {
      commands.push(command.type);
      report({ type: 'proposalReady', workflowId: 'old', attempt: 1, proposalId: 'proposal' });
      runtime.dispatch({ type: 'acceptProposal', workflowId: 'old', proposalId: 'proposal' });
      runtime.dispose();
    } });
    expect(runtime.dispatch({ type: 'runSkill', workflowId: 'old', noteId: 'note', skillId: 'cleanup' }).accepted).toBe(false);
    expect(commands).toEqual(['runSkill']);
    expect(runtime.getSnapshot()).toEqual({ kind: 'idle' });
  });
});
