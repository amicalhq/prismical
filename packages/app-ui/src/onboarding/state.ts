export type TourStep = 'record' | 'speak' | 'stop' | 'transcript' | 'enhance' | 'result' | 'review';
export type Walkthrough =
  | { status: 'offered'; replay?: boolean; started?: boolean }
  | { status: 'dismissed' | 'completed' }
  | { status: 'active'; orgId: string; noteId: string; step: TourStep; recordingId?: string };
export function walkthroughKey(userId: string) {
  return `prismical:first-note:v1:${encodeURIComponent(userId)}`;
}
export function readWalkthrough(key: string): Walkthrough | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (['offered', 'dismissed', 'completed'].includes(value?.status)) return value;
    if (
      value?.status === 'active' &&
      typeof value.orgId === 'string' &&
      typeof value.noteId === 'string' &&
      ['record', 'speak', 'stop', 'transcript', 'enhance', 'result', 'review'].includes(
        value.step
      ) &&
      (value.recordingId === undefined || typeof value.recordingId === 'string')
    )
      return value;
  } catch {
    /* Optional guide: unavailable storage must never interrupt the app. */
  }
  return { status: 'dismissed' };
}
export function writeWalkthrough(key: string, state: Walkthrough): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
export type WalkthroughEvent =
  | {
      type: 'error';
      noteId?: string;
      code:
        | 'create_failed'
        | 'recording_failed'
        | 'enhance_failed'
        | 'accept_failed'
        | 'target_unavailable'
        | 'tour_load_failed';
    }
  | { type: 'created'; noteId: string }
  | {
      type: 'recording' | 'ready-to-stop' | 'recorded' | 'review' | 'kept' | 'rejected';
      noteId: string;
      recordingId: string;
    }
  | { type: 'continue'; noteId: string };
export function advanceWalkthrough(
  state: Walkthrough | null,
  event: WalkthroughEvent,
  orgId?: string
): Walkthrough | null {
  if (event.type === 'error') return state;
  if (state?.status === 'offered' && state.started && event.type === 'created' && orgId)
    return { status: 'active', orgId, noteId: event.noteId, step: 'record' };
  if (state?.status !== 'active' || state.noteId !== event.noteId) return state;
  if (event.type === 'created') return state;
  if (event.type === 'continue') {
    if (state.step === 'transcript') return { ...state, step: 'enhance' };
    if (state.step === 'result') return { ...state, step: 'review' };
    return state;
  }
  if (
    event.type === 'recording' &&
    (state.step === 'record' || state.recordingId !== event.recordingId)
  )
    return { ...state, step: 'speak', recordingId: event.recordingId };
  if (event.recordingId !== state.recordingId) return state;
  if (event.type === 'ready-to-stop' && state.step === 'speak') return { ...state, step: 'stop' };
  if (event.type === 'recorded' && ['speak', 'stop'].includes(state.step))
    return { ...state, step: 'transcript' };
  if (event.type === 'review' && ['transcript', 'enhance'].includes(state.step))
    return { ...state, step: 'result' };
  if (event.type === 'rejected' && ['result', 'review'].includes(state.step))
    return { ...state, step: 'enhance' };
  if (event.type === 'kept' && ['result', 'review'].includes(state.step))
    return { status: 'completed' };
  return state;
}
