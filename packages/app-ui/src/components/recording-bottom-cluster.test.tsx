// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const state = vi.hoisted(() => ({
  note: { noteId: 'note_old', title: 'Old' } as { noteId: string; title: string } | null,
  rec: {} as Record<string, unknown>,
  panel: {} as Record<string, unknown>,
  candidates: new Map<string, unknown>(),
  activeRun: null as unknown,
  noop: vi.fn(),
  stop: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  t: (key: string) => key,
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
vi.mock('@prismical/app-client', () => {
  const store = Object.assign(
    (select: (s: unknown) => unknown) =>
      select({ waitingRecordingId: null, requestAutoEnhance: state.noop }),
    { getState: () => ({ clear: state.noop }) }
  );
  return {
    useRecording: () => state.rec,
    usePorts: () => ({
      analytics: { capture: state.noop },
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
  DockUnit: ({ pill, panel }: { pill: React.ReactNode; panel: React.ReactNode }) => (
    <>
      {pill}
      {panel}
    </>
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
vi.mock('./ask/ask-dock-pill', () => ({ AskPillFace: () => null, ASK_PILL_WIDTH: 100 }));
vi.mock('./ask/ask-panel', () => ({ AskPanel: () => null }));

const { RecordingBottomCluster } = await import('./recording-bottom-cluster');
afterEach(cleanup);
beforeEach(() => {
  state.noop.mockClear();
  state.stop.mockReset();
  state.push.mockReset();
  state.toast.mockReset();
  state.activeRun = null;
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
  it('hides the footer Start control during a skill run', () => {
    state.candidates.clear();
    state.activeRun = { status: 'running', skillName: 'Enhance' };
    const view = render(<RecordingBottomCluster />);
    expect(state.panel.hideStartRecording).toBe(true);
    state.activeRun = null;
    view.rerender(<RecordingBottomCluster />);
    expect(state.panel.hideStartRecording).toBe(false);
  });
  it('blocks same-note starts until the candidate is kept or undone', () => {
    const view = render(<RecordingBottomCluster />);
    expect(state.panel.startBlockedReason).toBe('recording.actions.reviewBeforeRecording');
    expect(state.panel.hideStartRecording).toBe(false);
    state.noop.mockClear();
    (state.panel.onStartRecording as () => void)();
    expect(state.noop).not.toHaveBeenCalled();
    state.candidates.delete('note_old');
    view.rerender(<RecordingBottomCluster />);
    expect(state.panel.startBlockedReason).toBeUndefined();
    expect(state.panel.hideStartRecording).toBe(false);
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
    expect(state.panel.hideStartRecording).toBe(false);
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
