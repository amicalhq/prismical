import { expect, it } from 'vitest';
import { createWorkflowRuntime } from './runtime';

it('admits one pending pause or resume and allows Stop to supersede it', () => {
  const runtime = createWorkflowRuntime();
  runtime.dispatch({ type: 'startRecording', workflowId: 'workflow', noteId: 'note' });
  runtime.dispatch({ type: 'captureReady', workflowId: 'workflow', attempt: 1, recordingId: 'audio' });
  const pause = runtime.dispatch({ type: 'pauseRecording', workflowId: 'workflow' });
  expect(pause.accepted).toBe(true);
  expect(runtime.dispatch({ type: 'pauseRecording', workflowId: 'workflow' }).accepted).toBe(false);
  expect(runtime.dispatch({ type: 'resumeRecording', workflowId: 'workflow' }).accepted).toBe(false);
  runtime.dispatch({ type: 'capturePaused', workflowId: 'workflow', attempt: 2 });
  expect(runtime.dispatch({ type: 'resumeRecording', workflowId: 'workflow' }).accepted).toBe(true);
  expect(runtime.dispatch({ type: 'resumeRecording', workflowId: 'workflow' }).accepted).toBe(false);
  expect(runtime.dispatch({ type: 'stopRecording', workflowId: 'workflow' }).accepted).toBe(true);
  expect(runtime.dispatch({ type: 'captureResumed', workflowId: 'workflow', attempt: 3 }).accepted).toBe(false);
  expect(runtime.getSnapshot()).toMatchObject({ phase: 'draining', control: undefined });
});

it('releases a failed pause so it can be retried, and ignores failure after Stop', () => {
  const runtime = createWorkflowRuntime();
  runtime.dispatch({ type: 'startRecording', workflowId: 'workflow', noteId: 'note' });
  runtime.dispatch({ type: 'captureReady', workflowId: 'workflow', attempt: 1, recordingId: 'audio' });
  runtime.dispatch({ type: 'pauseRecording', workflowId: 'workflow' });
  expect(runtime.dispatch({ type: 'captureControlFailed', workflowId: 'workflow', attempt: 2 }).accepted).toBe(true);
  expect(runtime.getSnapshot()).toMatchObject({ phase: 'capturing', control: undefined });
  expect(runtime.dispatch({ type: 'pauseRecording', workflowId: 'workflow' }).accepted).toBe(true);
  runtime.dispatch({ type: 'stopRecording', workflowId: 'workflow' });
  expect(runtime.dispatch({ type: 'captureControlFailed', workflowId: 'workflow', attempt: 3 }).accepted).toBe(false);
  expect(runtime.getSnapshot()).toMatchObject({ phase: 'draining' });
});

it('retains a recording ID finalized after Stop supersedes a pending Start', () => {
  const runtime = createWorkflowRuntime();
  runtime.dispatch({ type: 'startRecording', workflowId: 'workflow', noteId: 'note' });
  runtime.dispatch({ type: 'stopRecording', workflowId: 'workflow' });
  runtime.dispatch({ type: 'inputDrained', workflowId: 'workflow', attempt: 2 });
  runtime.dispatch({ type: 'finalizationSucceeded', workflowId: 'workflow', attempt: 3,
    recordingId: 'audio', autoSkill: { skillId: 'enhance' } });
  expect(runtime.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'running', recordingId: 'audio' });
});
