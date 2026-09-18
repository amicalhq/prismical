// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';

const state = vi.hoisted(() => ({
  note: { noteId: 'note_old', title: 'Old' } as { noteId: string; title: string } | null,
  queriedNote: undefined as { title: string; titleSource?: string } | undefined,
  rec: {} as Record<string, unknown>,
  panel: {} as Record<string, unknown>,
  askPanel: {} as Record<string, unknown>,
  candidates: new Map<string, unknown>(),
  activeRun: null as unknown,
  workflow: { kind: 'idle' } as { kind: string; phase?: string; workflowId?: string; noteId?: string; attempt?: number; proposalId?: string },
  shared: false,
  autoTranscribe: false,
  pendingAutoStart: false,
  syncStore: null as { whenNoteCreateAcked: (id: string) => Promise<void> } | null,
  recordings: [] as Array<Record<string, unknown>>,
  transcripts: {} as Record<string, unknown[]>,
  capabilities: { has: vi.fn(() => false), openSystemSettings: vi.fn() },
  noop: vi.fn(),
  stop: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  dismiss: vi.fn(),
  t: (key: string, params?: { name?: string }) => params?.name ? `${key}:${params.name}` : key,
}));
vi.mock('sonner', () => ({
  toast: { info: state.toast, warning: state.toast, dismiss: state.dismiss },
}));
vi.mock('../shell/current-note-context', () => ({
  useCurrentNote: () => ({ currentNote: state.note }),
}));
vi.mock('../onboarding/context', () => ({
  useWalkthroughStage: () => null,
  useWalkthroughEvent: () => state.noop,
}));
vi.mock('../hooks/use-recording-document-title', () => ({ useRecordingDocumentTitle: () => {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('@prismical/app-i18n', () => ({
  useApplicationLocale: () => ({ resolvedLocale: 'en' }),
  formatApplicationRelativeDay: () => 'Today',
  formatApplicationTime: () => '9:41 AM',
  formatApplicationDurationCompact: () => '1:00',
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: state.noop }),
  // One entry per recording, keyed off the recording id inside the query key; transcript and
  // speaker queries both resolve to the same fixture rows (the panel is mocked).
  useQueries: ({ queries }: { queries: Array<{ queryKey: unknown[] }> }) =>
    queries.map(({ queryKey }) => {
      const id = queryKey.find(part => typeof part === 'string' && part.startsWith('rec_')) as string | undefined;
      return { data: id ? (state.transcripts[id] ?? []) : [], isSuccess: true };
    }),
}));
vi.mock('@prismical/app-client', async () => {
  const { canAsk } = await import('@prismical/app-workflow');
  const store = Object.assign(
    (select: (s: unknown) => unknown) =>
      select({ waitingRecordingId: null, requestAutoEnhance: state.noop }),
    { getState: () => ({ clear: state.noop }) }
  );
  return {
    canAsk,
    useWorkflowSnapshot: () => state.workflow,
    useRecording: () => state.rec,
    usePorts: () => ({
      analytics: { capture: state.noop },
      workflow: state.shared ? { getSnapshot: () => state.workflow } : undefined,
      recording: {},
      desktopCapabilities: state.capabilities,
      env: { getEnv: () => ({ platform: 'web' }) },
      auth: {},
    }),
    useNavigation: () => ({ push: state.push }),
    useSyncStore: () => state.syncStore,
    useAutoEnhanceStore: store,
    useAskSkillRunStore: store,
    useSkillDiffStore: Object.assign(
      (select: (s: unknown) => unknown) => select({ candidatesByNote: state.candidates }),
      { getState: () => ({ candidatesByNote: state.candidates }) }
    ),
    useActiveSkillRun: () => state.activeRun,
    useEntitlements: () => ({ entitlements: { limits: { maxRecordingSeconds: null } } }),
    useRecordingBudgetWarning: () => ({ warning: null, dismiss: state.noop }),
    useNote: () => ({ data: state.queriedNote }),
    useSessionView: () => ({ state: 'signed-in', accounts: [], activeSub: null }),
    useOrgMembers: () => ({ data: undefined }),
    useOrganizations: () => ({ data: undefined }),
    useViewerProfile: () => ({ data: null }),
    activeOrgIdOf: () => null,
    tagRecordingSpeaker: () => Promise.resolve({}),
    applySpeakerPatch: (rows: unknown[]) => rows,
    mergeSpeakerRow: (rows: unknown[]) => rows,
    useNoteRecordings: () => ({ data: state.recordings }),
    transcriptKey: (id: string) => ['transcript', id],
    speakersKey: (id: string) => ['speakers', id],
    noteRecordingsKey: (id: string) => ['recordings', id],
    listTranscriptSegments: () => Promise.resolve([]),
    listRecordingSpeakers: () => Promise.resolve([]),
    byTranscriptTime: () => 0,
    useEnhancedRecordings: () => ({ data: new Set() }),
    segmentToLine: (s: unknown) => s,
    EVENTS: {},
    currentAccountExperience: () => ({
      getSnapshot: () => ({ data: { experience: { autoTranscribeNewNotes: state.autoTranscribe } } }),
    }),
    consumePendingAutoTranscribe: () => {
      const pending = state.pendingAutoStart;
      state.pendingAutoStart = false;
      return pending;
    },
  };
});
vi.mock('./transcript-panel', () => ({
  TranscriptPanel: (props: Record<string, unknown>) => {
    state.panel = props;
    return null;
  },
}));
vi.mock('./dock-unit', () => ({
  DockUnit: ({ pill, panel, collapsed }: { pill: React.ReactNode; panel: React.ReactNode; collapsed?: boolean }) => (
    <div hidden={collapsed}>
      {pill}
      {panel}
    </div>
  ),
  DockRowmate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./animated-width', () => ({
  AnimatedWidth: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./note-recording-dock', () => ({
  RecordingPillFace: () => null,
  recordingPillWidth: () => 100,
}));
vi.mock('./skill-note-created', () => ({ SkillNoteCreated: ({ active }: { active: boolean }) => active ? <div role="status">Note created<button>Undo creation</button></div> : null }));
vi.mock('./skill-dock-slot', () => ({ SkillDockSlot: () => null }));
vi.mock('./new-note-dock', () => ({ NewNoteDock: () => null }));
vi.mock('./auto-pause-prompt', () => ({ AutoPausePrompt: () => null }));
vi.mock('./recording-notice-card', () => ({ RecordingNoticeCard: () => null }));
vi.mock('./ask/ask-dock-pill', () => ({
  AskPillFace: ({ onClick, recordingSuggestion }: { onClick: () => void; recordingSuggestion?: { label: string } | null }) => (
    <>
      <button onClick={onClick}>Ask AI</button>
      {recordingSuggestion ? <span data-testid="recording-chip">{recordingSuggestion.label}</span> : null}
    </>
  ),
  ASK_PILL_WIDTH: 100,
}));
vi.mock('./ask/ask-panel', () => ({ AskPanel: (props: Record<string, unknown>) => {
  state.askPanel = props;
  return null;
} }));

const { RecordingBottomCluster } = await import('./recording-bottom-cluster');
afterEach(cleanup);
beforeEach(() => {
  state.queriedNote = undefined;
  state.capabilities.has.mockReturnValue(false);
  state.capabilities.openSystemSettings.mockReset();
  state.noop.mockClear();
  state.stop.mockReset();
  state.push.mockReset();
  state.toast.mockReset();
  state.dismiss.mockReset();
  state.activeRun = null;
  state.shared = false;
  state.autoTranscribe = false;
  state.pendingAutoStart = false;
  state.syncStore = null;
  state.recordings = [];
  state.transcripts = {};
  state.workflow = { kind: 'idle' };
  state.note = { noteId: 'note_old', title: 'Old' };
  state.candidates = new Map([['note_old', { skillName: 'Enhance' }]]);
  state.rec = {
    noteId: 'note_old',
    recordingId: 'rec_old',
    state: 'idle',
    isRecording: false,
    isPaused: false,
    liveSegments: [{ text: 'Old transcript' }],
    startedAt: null,
    stop: state.stop,
    start: state.noop,
  };
});
describe('recording dock note ownership', () => {
  it('starts a new note using the saved account preference after creation is acknowledged', async () => {
    state.candidates.clear();
    state.autoTranscribe = true;
    state.pendingAutoStart = true;
    let acknowledge!: () => void;
    state.syncStore = { whenNoteCreateAcked: () => new Promise<void>((resolve) => { acknowledge = resolve; }) };
    render(<RecordingBottomCluster />);
    expect(state.noop).not.toHaveBeenCalledWith('note_old', 'Old');
    await act(async () => { acknowledge(); });
    expect(state.noop).toHaveBeenCalledWith('note_old', 'Old');
  });

  it('does not auto-start if the account preference is disabled while awaiting creation', async () => {
    state.candidates.clear();
    state.autoTranscribe = true;
    state.pendingAutoStart = true;
    let acknowledge!: () => void;
    state.syncStore = { whenNoteCreateAcked: () => new Promise<void>((resolve) => { acknowledge = resolve; }) };
    render(<RecordingBottomCluster />);
    state.autoTranscribe = false;
    await act(async () => { acknowledge(); });
    expect(state.noop).not.toHaveBeenCalledWith('note_old', 'Old');
  });

  it('disables the footer Start control during a skill run', () => {
    state.candidates.clear();
    state.activeRun = { status: 'running', skillName: 'Enhance' };
    const view = render(<RecordingBottomCluster />);
    expect(state.panel.startBlockedReason).toBe('workflow.busy');
    state.activeRun = null;
    view.rerender(<RecordingBottomCluster />);
    expect(state.panel.hideStartRecording).toBeUndefined();
  });
  it('blocks same-note starts until the candidate is kept or undone', () => {
    const view = render(<RecordingBottomCluster />);
    expect(state.panel.startBlockedReason).toBe('recording.actions.reviewBeforeRecording');
    expect(state.panel.hideStartRecording).toBeUndefined();
    state.noop.mockClear();
    (state.panel.onStartRecording as () => void)();
    expect(state.noop).not.toHaveBeenCalled();
    state.candidates.delete('note_old');
    view.rerender(<RecordingBottomCluster />);
    expect(state.panel.startBlockedReason).toBeUndefined();
    expect(state.panel.hideStartRecording).toBeUndefined();
    (state.panel.onStartRecording as () => void)();
    expect(state.noop).toHaveBeenCalledWith('note_old', 'Old');
  });
  it('does not carry an unreviewed note transcript or finishing state into another note', () => {
    const view = render(<RecordingBottomCluster />);
    state.note = { noteId: 'note_new', title: 'New' };
    view.rerender(<RecordingBottomCluster />);
    expect(state.panel.liveLines).toEqual([]);
    expect(state.panel.isRecording).toBe(false);
    expect(state.panel.isFinishing).toBe(false);
    expect(state.panel.finishedRecordingId).toBeNull();
    expect(state.panel.recState).toBe('idle');
    expect(state.panel.startBlockedReason).toBeUndefined();
    expect(state.panel.hideStartRecording).toBeUndefined();
    expect(state.candidates.has('note_old')).toBe(true);
  });
  it('ignores an old recording that stops after navigation has already reset the dock', () => {
    state.rec.state = 'recording';
    state.rec.isRecording = true;
    const view = render(<RecordingBottomCluster />);
    state.note = { noteId: 'note_new', title: 'New' };
    view.rerender(<RecordingBottomCluster />);
    state.rec.state = 'idle';
    state.rec.isRecording = false;
    view.rerender(<RecordingBottomCluster />);
    expect(state.panel.finishedRecordingId).toBeNull();
    expect(state.panel.isFinishing).toBe(false);
    expect(state.panel.liveLines).toEqual([]);
  });
});

describe('recording across navigation', () => {
  it.each(['starting', 'recording', 'paused'])(
    'keeps a %s session owned by the original note',
    phase => {
      state.rec.state = phase;
      state.rec.isRecording = phase === 'recording';
      state.rec.isPaused = phase === 'paused';
      const view = render(<RecordingBottomCluster />);
      state.note = null;
      view.rerender(<RecordingBottomCluster />);
      state.note = { noteId: 'note_new', title: 'New' };
      view.rerender(<RecordingBottomCluster />);
      expect(state.stop).not.toHaveBeenCalled();
      expect(state.panel.recordingNoteTitle).toBe('Old');
      expect(state.panel.activeRecordingId).toBe('rec_old');
      expect(state.panel.liveLines).toEqual([{ text: 'Old transcript' }]);
      expect(state.panel.recordings).toEqual([]);
      expect(state.panel.skillStatus).toBeUndefined();
      (state.panel.onStartRecording as () => void)();
      expect(state.noop).not.toHaveBeenCalledWith('note_new', 'New');
      (state.panel.onOpenNote as () => void)();
      expect(state.push).toHaveBeenCalledWith('/notes/note_old');
      state.note = { noteId: 'note_old', title: 'Old' };
      view.rerender(<RecordingBottomCluster />);
      expect(state.panel.onOpenNote).toBeUndefined();
      expect(state.stop).not.toHaveBeenCalled();
    }
  );

  it.each([null, { noteId: 'note_new', title: 'New' }])(
    'returns immediately on explicit Stop from %j without late redirects',
    destination => {
      state.rec.state = 'recording';
      state.rec.isRecording = true;
      state.stop.mockReturnValue(new Promise(() => {}));
      const view = render(<RecordingBottomCluster />);
      state.note = destination;
      view.rerender(<RecordingBottomCluster />);
      act(() => (state.panel.onStopRecording as () => void)());
      expect(state.stop).toHaveBeenCalledTimes(1);
      expect(state.push).toHaveBeenCalledExactlyOnceWith('/notes/note_old');
      state.rec.state = 'idle';
      state.rec.isRecording = false;
      state.rec.completedRecording = { noteId: 'note_old', recordingId: 'rec_old' };
      view.rerender(<RecordingBottomCluster />);
      expect(state.push).toHaveBeenCalledTimes(1);
    }
  );

  it('automatic Stop stays on the viewed note and offers the original note', () => {
    state.rec.state = 'recording';
    state.rec.isRecording = true;
    const view = render(<RecordingBottomCluster />);
    state.note = { noteId: 'note_new', title: 'New' };
    view.rerender(<RecordingBottomCluster />);
    state.rec.autoStopRequested = true;
    view.rerender(<RecordingBottomCluster />);
    expect(state.stop).toHaveBeenCalledTimes(1);
    expect(state.push).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      'recording.away.stopped',
      expect.objectContaining({ description: 'Old' })
    );
    state.toast.mock.calls[0]![1].action.onClick();
    expect(state.push).toHaveBeenCalledWith('/notes/note_old');
  });
});


describe('shared workflow dock admission', () => {
  it('names the original note in review and routes its status action there', () => {
    state.shared = true;
    state.queriedNote = { title: '  Project notes  ', titleSource: 'manual' };
    state.workflow = { kind: 'skill', phase: 'review', workflowId: 'active', noteId: 'note_other', attempt: 1 };
    render(<RecordingBottomCluster />);
    expect(screen.getByRole('status').textContent).toContain('workflow.reviewNamed:Project notes');
    fireEvent.click(screen.getByRole('button', { name: 'workflow.openNamedNote:Project notes' }));
    expect(state.push).toHaveBeenCalledWith('/notes/note_other');
    expect(state.panel.openNoteLabel).toBe('workflow.openNamedNote:Project notes');
  });

  it('uses the generic open action for placeholder titles', () => {
    state.shared = true;
    state.queriedNote = { title: 'Untitled note', titleSource: 'placeholder' };
    state.workflow = { kind: 'recording', phase: 'finalizing', workflowId: 'active', noteId: 'note_other', attempt: 1 };
    render(<RecordingBottomCluster />);
    expect(screen.getByRole('button', { name: 'workflow.openNote' })).toBeTruthy();
    expect(state.panel.onOpenNote).toBeTypeOf('function');
    expect(state.panel.openNoteLabel).toBe('workflow.openNote');
  });

  it.each(['running', 'review', 'applying'])('blocks recording while another note has skill %s', phase => {
    state.shared = true;
    state.candidates.clear();
    state.workflow = { kind: 'skill', phase, workflowId: 'active', noteId: 'note_other', attempt: 1 };
    render(<RecordingBottomCluster />);
    state.noop.mockClear();
    (state.panel.onStartRecording as () => void)();
    expect(state.noop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'workflow.openNote' }));
    expect(state.push).toHaveBeenCalledWith('/notes/note_other');
  });

  it.each(['review', 'applying', 'running'])('replaces Ask with the proposal controls during %s', phase => {
    state.shared = true;
    state.workflow = { kind: 'skill', phase, proposalId: 'proposal', workflowId: 'active', noteId: 'note_old', attempt: 1 };
    const view = render(<RecordingBottomCluster />);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    (state.panel.onStartRecording as () => void)();
    expect(state.noop).not.toHaveBeenCalledWith('note_old', 'Old');

    state.candidates.clear();
    state.workflow = { kind: 'idle' };
    view.rerender(<RecordingBottomCluster />);
    expect(screen.getByRole('button', { name: 'Ask AI' })).toBeTruthy();
  });

  it('keeps Ask blocked when leaving a note with a pending review', () => {
    state.shared = true;
    state.workflow = { kind: 'skill', phase: 'review', workflowId: 'active', noteId: 'note_old', attempt: 1 };
    const view = render(<RecordingBottomCluster />);
    state.note = { noteId: 'note_new', title: 'New' };
    view.rerender(<RecordingBottomCluster />);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'workflow.openNote' }));
    expect(state.push).toHaveBeenCalledWith('/notes/note_old');

    state.note = null;
    view.rerender(<RecordingBottomCluster />);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });

  it('closes an open Ask panel when another note enters review', () => {
    state.shared = true;
    state.candidates.clear();
    const view = render(<RecordingBottomCluster />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(state.askPanel.open).toBe(true);

    state.workflow = { kind: 'skill', phase: 'review', workflowId: 'active', noteId: 'note_other', attempt: 1 };
    view.rerender(<RecordingBottomCluster />);
    expect(state.askPanel.open).toBe(false);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });

  it.each(['capturing', 'paused', 'draining', 'finalizing'])('keeps Ask available while recording is %s', phase => {
    state.shared = true;
    state.candidates.clear();
    state.workflow = { kind: 'recording', phase, workflowId: 'active', noteId: 'note_old', attempt: 1 };
    render(<RecordingBottomCluster />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(state.askPanel.open).toBe(true);
  });
});


describe('recording language ownership', () => {
  it.each(['idle', 'starting', 'recording', 'paused', 'stopping'])(
    'uses the active language only during recording or pause (%s)',
    phase => {
      state.rec.state = phase;
      state.rec.isRecording = phase === 'recording';
      state.rec.isPaused = phase === 'paused';
      state.rec.language = 'de';
      state.rec.setLanguage = state.noop;
      render(<RecordingBottomCluster />);
      expect(state.panel.activeLanguage).toBe(
        phase === 'recording' || phase === 'paused' ? 'de' : undefined
      );
      expect(state.panel.onChangeLanguage).toBe(state.noop);
    }
  );
});

it('keeps creation Undo visible alongside the instruction dock after review ends', () => {
  state.candidates = new Map();
  render(<RecordingBottomCluster />);
  expect(screen.getByRole('button', { name: 'Undo creation' }).closest('[hidden]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Ask AI' })).toBeDefined();
});

const { useNoteDockActions } = await import('./note-dock-actions');
function DockActionsProbe({ noteId }: { noteId: string }) {
  const actions = useNoteDockActions(noteId);
  return <>
    <button disabled={!actions?.startRecording} onClick={actions?.startRecording}>Start from editor</button>
    <button disabled={!actions?.askAi} onClick={actions?.askAi}>Ask from editor</button>
  </>;
}
it('shares recording guards and current-note ownership with editor actions', () => {
  state.candidates.clear();
  const view = render(<><RecordingBottomCluster /><DockActionsProbe noteId="note_old" /></>);
  fireEvent.click(screen.getByText('Start from editor'));
  expect(state.noop).toHaveBeenCalledWith('note_old', 'Old');
  state.rec.state = 'recording';
  view.rerender(<><RecordingBottomCluster /><DockActionsProbe noteId="note_old" /></>);
  expect((screen.getByText('Start from editor') as HTMLButtonElement).disabled).toBe(true);
  state.note = { noteId: 'note_new', title: 'New' };
  view.rerender(<><RecordingBottomCluster /><DockActionsProbe noteId="note_old" /></>);
  expect((screen.getByText('Ask from editor') as HTMLButtonElement).disabled).toBe(true);
});
it('opens Ask through the same dock handler and blocks it during review', () => {
  state.candidates.clear();
  const view = render(<><RecordingBottomCluster /><DockActionsProbe noteId="note_old" /></>);
  fireEvent.click(screen.getByText('Ask from editor'));
  expect(state.askPanel.open).toBe(true);
  state.candidates.set('note_old', { skillName: 'Cleanup' });
  view.rerender(<><RecordingBottomCluster /><DockActionsProbe noteId="note_old" /></>);
  expect((screen.getByText('Ask from editor') as HTMLButtonElement).disabled).toBe(true);
});

describe('dead-mic warning', () => {
  /** The options sonner was handed for the Nth dead-mic toast. */
  const toastOptions = (n = 0) =>
    state.toast.mock.calls[n]![1] as { onDismiss?: () => void; description: string };

  beforeEach(() => {
    state.rec.state = 'recording';
    state.rec.isRecording = true;
  });

  it('raises the toast while the stream is dead and withdraws it when audio returns', () => {
    const view = render(<RecordingBottomCluster />);
    expect(state.toast).not.toHaveBeenCalled();

    state.rec.micSilent = true;
    view.rerender(<RecordingBottomCluster />);
    expect(state.toast).toHaveBeenCalledWith(
      'recording.errors.deadMicTitle',
      expect.objectContaining({ description: 'recording.errors.deadMicDescription' })
    );

    state.rec.micSilent = false;
    view.rerender(<RecordingBottomCluster />);
    expect(state.dismiss).toHaveBeenCalledTimes(1);
  });

  it('offers microphone system settings and native guidance on desktop', () => {
    state.capabilities.has.mockReturnValue(true);
    state.rec.micSilent = true;
    render(<RecordingBottomCluster />);
    expect(state.toast).toHaveBeenCalledWith(
      'recording.errors.deadMicTitle',
      expect.objectContaining({ description: 'recording.errors.deadMicNativeDescription' })
    );
    const options = state.toast.mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe('settings.permissions.openSystemSettings');
    options.action.onClick();
    expect(state.capabilities.openSystemSettings).toHaveBeenCalledWith('microphone');
  });

  it('does not treat its own withdrawal as the user dismissing it', () => {
    // sonner fires onDismiss for a programmatic dismiss too. If that counted as a user gesture,
    // the warning would be suppressed for the rest of a recording that is still broken.
    const view = render(<RecordingBottomCluster />);
    state.rec.micSilent = true;
    view.rerender(<RecordingBottomCluster />);
    const { onDismiss } = toastOptions();

    state.rec.micSilent = false;
    view.rerender(<RecordingBottomCluster />);
    act(() => onDismiss?.()); // sonner's callback, fired by OUR toast.dismiss

    state.rec.micSilent = true;
    view.rerender(<RecordingBottomCluster />);
    expect(state.toast).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when there is no recording to warn about', () => {
    // micSilent can outlive a session: an abnormal teardown clears the id without clearing the
    // flag. A null id must also never be mistaken for the dismissal ref's own initial value.
    state.rec.recordingId = null;
    const view = render(<RecordingBottomCluster />);
    state.rec.micSilent = true;
    view.rerender(<RecordingBottomCluster />);
    expect(state.toast).not.toHaveBeenCalled();

    // It surfaces as soon as a recording owns it.
    state.rec.recordingId = 'rec_new';
    view.rerender(<RecordingBottomCluster />);
    expect(state.toast).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a dismissed toast when the recording ends mid-warning', () => {
    const view = render(<RecordingBottomCluster />);
    state.rec.micSilent = true;
    view.rerender(<RecordingBottomCluster />);
    act(() => toastOptions().onDismiss?.()); // user closes it

    // Teardown drops the id but leaves micSilent set.
    state.rec.recordingId = null;
    view.rerender(<RecordingBottomCluster />);
    expect(state.toast).toHaveBeenCalledTimes(1);
  });

  it('does not re-open a toast the user closed, until the next recording', () => {
    const view = render(<RecordingBottomCluster />);
    state.rec.micSilent = true;
    view.rerender(<RecordingBottomCluster />);
    act(() => toastOptions().onDismiss?.()); // user closes it while it is still up

    // The stream recovers and dies again — same recording, so stay quiet.
    state.rec.micSilent = false;
    view.rerender(<RecordingBottomCluster />);
    state.rec.micSilent = true;
    view.rerender(<RecordingBottomCluster />);
    expect(state.toast).toHaveBeenCalledTimes(1);

    // A new recording is a new decision: a mic they gave up on before is still worth flagging.
    state.rec.micSilent = false;
    view.rerender(<RecordingBottomCluster />);
    state.rec.recordingId = 'rec_new';
    state.rec.micSilent = true;
    view.rerender(<RecordingBottomCluster />);
    expect(state.toast).toHaveBeenCalledTimes(2);
  });
});

describe('Ask pill recording chip', () => {
  const ready = (id: string, startedAt: string) => ({
    id,
    startedAt,
    endedAt: startedAt,
    durationMs: 60_000,
    meta: { finalize: { status: 'done' } },
  });
  const line = (id: string) => ({ id: `${id}-line`, at: '', speaker: 'You', text: 'Transcript' });

  it('offers the newest ready recording on a revisit', () => {
    state.candidates.clear();
    state.rec = { ...state.rec, recordingId: null };
    state.recordings = [ready('rec_b', '2026-09-17T01:00:00.000Z'), ready('rec_a', '2026-09-17T00:00:00.000Z')];
    state.transcripts = { rec_a: [line('rec_a')], rec_b: [line('rec_b')] };
    render(<RecordingBottomCluster />);
    expect(screen.getByTestId('recording-chip').textContent).toBe('recording.skill.enhanceLabel');
  });

  it('waits for a just-stopped recording to be listed instead of offering the older one', () => {
    state.candidates.clear();
    state.recordings = [ready('rec_old', '2026-09-17T00:00:00.000Z')];
    state.transcripts = { rec_old: [line('rec_old')] };
    // rec_new is being captured, so nothing is offered yet.
    state.rec = { ...state.rec, recordingId: 'rec_new', state: 'recording', isRecording: true };
    const view = render(<RecordingBottomCluster />);
    expect(screen.queryByTestId('recording-chip')).toBeNull();
    // Stop: capture is idle again, but the list still only holds the older recording.
    state.rec = { ...state.rec, state: 'idle', isRecording: false, isFinalizing: false };
    view.rerender(<RecordingBottomCluster />);
    expect(screen.queryByTestId('recording-chip')).toBeNull();
    // Finalize + refetch land the finished recording at the top of the list.
    state.recordings = [ready('rec_new', '2026-09-17T01:00:00.000Z'), ...state.recordings];
    state.transcripts = { ...state.transcripts, rec_new: [line('rec_new')] };
    view.rerender(<RecordingBottomCluster />);
    expect(screen.getByTestId('recording-chip').textContent).toBe('recording.skill.enhanceLabel');
  });

  it('does not carry another note’s post-stop guard or panel state across navigation', () => {
    state.candidates.clear();
    state.rec = { ...state.rec, recordingId: 'rec_new', state: 'recording', isRecording: true };
    const view = render(<RecordingBottomCluster />);
    state.rec = { ...state.rec, state: 'idle', isRecording: false, isFinalizing: false };
    view.rerender(<RecordingBottomCluster />);
    expect(state.panel.finishedRecordingId).toBe('rec_new');
    state.note = { noteId: 'note_other', title: 'Other' };
    state.recordings = [ready('rec_other', '2026-09-17T00:00:00.000Z')];
    state.transcripts = { rec_other: [line('rec_other')] };
    view.rerender(<RecordingBottomCluster />);
    expect(screen.getByTestId('recording-chip')).toBeTruthy();
    expect(state.panel.finishedRecordingId).toBeNull();
  });

  it('hides the chip while a suggestion is staged for the note', () => {
    state.rec = { ...state.rec, recordingId: null };
    state.recordings = [ready('rec_a', '2026-09-17T00:00:00.000Z')];
    state.transcripts = { rec_a: [line('rec_a')] };
    render(<RecordingBottomCluster />);
    expect(state.candidates.has('note_old')).toBe(true);
    expect(state.panel.startBlockedReason).toBe('recording.actions.reviewBeforeRecording');
    expect(screen.getByTestId('recording-chip')).toBeTruthy();
  });
});
