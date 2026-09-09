import { describe, expect, it } from 'vitest';
import { canAsk } from './machine';
import { createWorkflowRuntime } from './runtime';
import type { RecordingPhase } from './types';

describe('Ask admission', () => {
  it.each<RecordingPhase>(['starting', 'capturing', 'paused', 'draining', 'finalizing'])(
    'allows Ask throughout recording: %s',
    phase => {
      expect(
        canAsk({ kind: 'recording', phase, workflowId: 'wf', noteId: 'note', attempt: 1 })
      ).toBe(true);
    }
  );

  it('blocks through review, refinement and application, then allows Ask after acceptance', () => {
    const runtime = createWorkflowRuntime();
    expect(canAsk(runtime.getSnapshot())).toBe(true);
    runtime.dispatch({
      type: 'runSkill',
      workflowId: 'wf',
      noteId: 'another-note',
      skillId: 'skill',
    });
    expect(canAsk(runtime.getSnapshot())).toBe(true);
    runtime.dispatch({
      type: 'proposalReady',
      workflowId: 'wf',
      attempt: 1,
      proposalId: 'proposal',
    });
    expect(canAsk(runtime.getSnapshot())).toBe(false);
    runtime.dispatch({ type: 'refineSkill', workflowId: 'wf', proposalId: 'proposal' });
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'running', proposalId: 'proposal' });
    expect(canAsk(runtime.getSnapshot())).toBe(false);
    runtime.dispatch({
      type: 'proposalReady',
      workflowId: 'wf',
      attempt: 2,
      proposalId: 'refined',
    });
    runtime.dispatch({ type: 'acceptProposal', workflowId: 'wf', proposalId: 'refined' });
    expect(canAsk(runtime.getSnapshot())).toBe(false);
    runtime.dispatch({ type: 'applySucceeded', workflowId: 'wf', attempt: 3 });
    expect(canAsk(runtime.getSnapshot())).toBe(true);
  });
});
