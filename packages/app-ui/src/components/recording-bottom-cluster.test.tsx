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
  noop: vi.fn(),
  stop: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  t: (key: string, params?: { name?: string }) => params?.name ? `${key}:${params.name}` : key,
}));
vi.mock('sonner', () => ({ toast: { info: state.toast, warning: state.toast } }));
vi.mock('../shell/current-note-context', () => ({
  useCurrentNote: () => ({ currentNote: state.note }),
}));
vi.mock('../onboarding/context', () => ({
  useWalkthroughStage: () => null,
  useWalkthroughEvent: () => state.noop,
}));
vi.mock('../hooks/use-recording-document-title', () => ({ useRecordingDocumentTitle: () => {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('@prismical/app-i18n', () => ({ useApplicationLocale: () => ({ resolvedLocale: 'en' }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: state.noop }),
  useQueries: () => [],
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
      env: { getEnv: () => ({ platform: 'web' }) },
      auth: {},
    }),
    useNavigation: () => ({ push: state.push }),
    useSyncStore: () => null,
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
    useNoteRecordings: () => ({ data: [] }),
    useEnhancedRecordings: () => ({ data: new Set() }),
    segmentToLine: (s: unknown) => s,
    EVENTS: {},
    getRecordingPreferences: () => ({}),
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
vi.mock('./skill-dock-slot', () => ({ SkillDockSlot: () => null }));
vi.mock('./new-note-dock', () => ({ NewNoteDock: () => null }));
vi.mock('./auto-pause-prompt', () => ({ AutoPausePrompt: () => null }));
vi.mock('./recording-notice-card', () => ({ RecordingNoticeCard: () => null }));
vi.mock('./ask/ask-dock-pill', () => ({ AskPillFace: ({ onClick }: { onClick: () => void }) => <button onClick={onClick}>Ask AI</button>, ASK_PILL_WIDTH: 100 }));
vi.mock('./ask/ask-panel', () => ({ AskPanel: (props: Record<string, unknown>) => {
  state.askPanel = props;
  return null;
} }));

const { RecordingBottomCluster } = await import('./recording-bottom-cluster');
afterEach(cleanup);
beforeEach(() => {
  state.queriedNote = undefined;
  state.noop.mockClear();
  state.stop.mockReset();
  state.push.mockReset();
  state.toast.mockReset();
  state.activeRun = null;
  state.shared = false;
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
