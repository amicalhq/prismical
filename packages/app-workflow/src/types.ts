export interface WorkflowScope {
  readonly workflowId: string;
  readonly attempt: number;
}

interface ActiveWorkflow extends WorkflowScope {
  readonly noteId: string;
}

export type RecordingPhase = 'starting' | 'capturing' | 'paused' | 'draining' | 'finalizing';

export interface RecordingWorkflow extends ActiveWorkflow {
  readonly kind: 'recording';
  readonly phase: RecordingPhase;
  readonly recordingId?: string;
  readonly control?: 'pausing' | 'resuming';
}

export interface SkillWorkflow extends ActiveWorkflow {
  readonly kind: 'skill';
  readonly phase: 'running' | 'review' | 'applying';
  readonly skillId: string;
  readonly recordingId?: string;
  readonly proposalId?: string;
  readonly error?: string;
}

export type WorkflowState = Readonly<{ kind: 'idle' }> | RecordingWorkflow | SkillWorkflow;

export type WorkflowRequest =
  | { type: 'startRecording'; workflowId: string; noteId: string; recordingId?: string }
  | { type: 'runSkill'; workflowId: string; noteId: string; skillId: string }
  | { type: 'pauseRecording' | 'resumeRecording' | 'stopRecording'; workflowId: string }
  | { type: 'refineSkill' | 'acceptProposal' | 'declineProposal'; workflowId: string; proposalId: string };

export type WorkflowFact = WorkflowScope & (
  | { type: 'captureReady'; recordingId: string }
  | { type: 'capturePaused' | 'captureResumed' | 'captureControlFailed' }
  | { type: 'inputDrained' }
  | { type: 'finalizationSucceeded'; recordingId?: string; autoSkill?: { skillId: string } }
  | { type: 'recordingFailed'; captureClosed: true }
  | { type: 'proposalReady'; proposalId: string }
  | { type: 'skillNoChange' | 'skillFailed' | 'skillCancelled' | 'skillHostClosed' | 'applySucceeded' }
  | { type: 'applyFailed'; error?: string }
);

export type WorkflowEvent = WorkflowRequest | WorkflowFact;

export type WorkflowCommand =
  | { type: 'startCapture' | 'pauseCapture' | 'resumeCapture' | 'stopCapture' | 'finalizeRecording'; scope: RecordingWorkflow }
  | { type: 'runSkill' | 'applyProposal' | 'discardProposal'; scope: SkillWorkflow };

export interface WorkflowTransition {
  readonly accepted: boolean;
  readonly state: WorkflowState;
  readonly commands: readonly WorkflowCommand[];
}

export interface WorkflowAcknowledgment {
  readonly accepted: boolean;
  readonly state: WorkflowState;
}

/** The UI may request work; adapter completion facts enter through the runtime. */
export interface WorkflowClient {
  getSnapshot(): WorkflowState;
  subscribe(listener: () => void): () => void;
  request(event: WorkflowRequest): Promise<WorkflowAcknowledgment>;
}

export interface WorkflowTimerHost {
  schedule(delayMs: number, callback: () => void): () => void;
}
