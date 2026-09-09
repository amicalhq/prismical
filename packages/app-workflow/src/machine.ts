import type { RecordingWorkflow, SkillWorkflow, WorkflowCommand, WorkflowEvent, WorkflowState, WorkflowTransition } from './types';

export const idleWorkflow: WorkflowState = Object.freeze({ kind: 'idle' });

export function canStartRecording(state: WorkflowState): boolean {
  return state.kind === 'idle';
}

export const canRunSkill = canStartRecording;

/** A pending proposal owns the review surface, including while it is being refined. */
export function canAsk(state: WorkflowState): boolean {
  return state.kind !== 'skill' || (state.phase === 'running' && state.proposalId === undefined);
}

export function transition(state: WorkflowState, event: WorkflowEvent): WorkflowTransition {
  const reject = (): WorkflowTransition => ({ accepted: false, state, commands: [] });
  const accept = (next: WorkflowState, commands: WorkflowCommand[] = []): WorkflowTransition => ({ accepted: true, state: next, commands });
  const record = (next: RecordingWorkflow, type: Extract<WorkflowCommand, { scope: RecordingWorkflow }>['type']) =>
    accept(next, [{ type, scope: next }]);
  const skill = (next: SkillWorkflow, type: Extract<WorkflowCommand, { scope: SkillWorkflow }>['type']) =>
    accept(next, [{ type, scope: next }]);

  if (event.type === 'startRecording') {
    if (!canStartRecording(state)) return reject();
    return record({ kind: 'recording', phase: 'starting', workflowId: event.workflowId, noteId: event.noteId, recordingId: event.recordingId, attempt: 1 }, 'startCapture');
  }
  if (event.type === 'runSkill') {
    if (!canRunSkill(state)) return reject();
    return skill({ kind: 'skill', phase: 'running', workflowId: event.workflowId, noteId: event.noteId, skillId: event.skillId, attempt: 1 }, 'runSkill');
  }
  if (state.kind === 'idle' || state.workflowId !== event.workflowId) return reject();
  if ('attempt' in event && state.attempt !== event.attempt) return reject();

  if (state.kind === 'recording') {
    switch (event.type) {
      case 'captureReady':
        return state.phase === 'starting' ? accept({ ...state, phase: 'capturing', recordingId: event.recordingId }) : reject();
      case 'pauseRecording':
        return state.phase === 'capturing' && !state.control
          ? record({ ...state, control: 'pausing', attempt: state.attempt + 1 }, 'pauseCapture') : reject();
      case 'resumeRecording':
        return state.phase === 'paused' && !state.control
          ? record({ ...state, control: 'resuming', attempt: state.attempt + 1 }, 'resumeCapture') : reject();
      case 'capturePaused':
        return state.phase === 'capturing' && state.control === 'pausing'
          ? accept({ ...state, phase: 'paused', control: undefined }) : reject();
      case 'captureResumed':
        return state.phase === 'paused' && state.control === 'resuming'
          ? accept({ ...state, phase: 'capturing', control: undefined }) : reject();
      case 'captureControlFailed':
        return state.control ? accept({ ...state, control: undefined }) : reject();
      case 'stopRecording':
        return ['starting', 'capturing', 'paused'].includes(state.phase)
          ? record({ ...state, phase: 'draining', control: undefined, attempt: state.attempt + 1 }, 'stopCapture') : reject();
      case 'inputDrained':
        return state.phase === 'draining'
          ? record({ ...state, phase: 'finalizing', attempt: state.attempt + 1 }, 'finalizeRecording') : reject();
      case 'finalizationSucceeded':
        if (state.phase !== 'finalizing') return reject();
        if (event.recordingId && state.recordingId && event.recordingId !== state.recordingId) return reject();
        return event.autoSkill
          ? skill({ kind: 'skill', phase: 'running', workflowId: state.workflowId, noteId: state.noteId, recordingId: event.recordingId ?? state.recordingId, skillId: event.autoSkill.skillId, attempt: state.attempt + 1 }, 'runSkill')
          : accept(idleWorkflow);
      case 'recordingFailed':
        return accept(idleWorkflow);
      default:
        return reject();
    }
  }

  if ((event.type === 'refineSkill' || event.type === 'acceptProposal' || event.type === 'declineProposal') && event.proposalId !== state.proposalId) return reject();

  switch (event.type) {
    case 'skillHostClosed':
      return accept(idleWorkflow);
    case 'proposalReady':
      return state.phase === 'running' ? accept({ ...state, phase: 'review', proposalId: event.proposalId }) : reject();
    case 'skillNoChange':
    case 'skillFailed':
    case 'skillCancelled':
      return state.phase === 'running'
        ? accept(state.proposalId ? { ...state, phase: 'review' } : idleWorkflow) : reject();
    case 'refineSkill':
      return state.phase === 'review' ? skill({ ...state, phase: 'running', attempt: state.attempt + 1, error: undefined }, 'runSkill') : reject();
    case 'acceptProposal':
      return state.phase === 'review' ? skill({ ...state, phase: 'applying', attempt: state.attempt + 1, error: undefined }, 'applyProposal') : reject();
    case 'declineProposal':
      return state.phase === 'review' ? accept(idleWorkflow, [{ type: 'discardProposal', scope: state }]) : reject();
    case 'applySucceeded':
      return state.phase === 'applying' ? accept(idleWorkflow) : reject();
    case 'applyFailed':
      return state.phase === 'applying' ? accept({ ...state, phase: 'review', error: event.error }) : reject();
    default:
      return reject();
  }
}
