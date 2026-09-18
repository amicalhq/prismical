// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => ({ featureFlags: null as Record<string, boolean> | null }));

vi.mock('../onboarding/context', () => ({ useWalkthroughStage: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { number?: number }) =>
      args?.number === undefined ? key : `${key} ${args.number}`,
  }),
}));
vi.mock('@prismical/app-i18n', () => ({
  useApplicationLocale: () => ({ resolvedLocale: 'en' }),
  formatApplicationDuration: () => '',
}));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => capabilities,
  useSessionView: () => ({ accounts: [], activeSub: null }),
  useViewerProfile: () => ({ data: null }),
  useAutoEnhanceStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('./note-recording-dock', () => ({ formatSessionTimer: () => '0:00' }));
// Radix menus need pointer capture jsdom lacks; render the menu inline with items as buttons.
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));
vi.mock('./dock-mic-menu', () => ({ DockMicMenu: () => null }));
vi.mock('./speaker-person-picker', () => ({
  SpeakerPersonPicker: ({ onPick }: { onPick: (p: { id: string; email: string; name: string | null }) => void }) => (
    <button type="button" onClick={() => onPick({ id: 'prs_pick', email: 'p@example.com', name: 'Pat' })}>
      pick-person
    </button>
  ),
}));
vi.mock('./waveform', () => ({ Waveform: () => null }));
vi.mock('../ui/message-scroller', () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    MessageScrollerProvider: Container,
    MessageScroller: Container,
    MessageScrollerViewport: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="transcript-body">{children}</div>
    ),
    MessageScrollerContent: Container,
    MessageScrollerItem: Container,
    MessageScrollerButton: () => null,
    useMessageScroller: () => ({ scrollToMessage: vi.fn() }),
  };
});

import { TranscriptPanel, type RecordingLog } from './transcript-panel';

afterEach(cleanup);
const base = {
  liveLines: [],
  recordings: [],
  onEnhanceRecording: vi.fn(),
  isExpanded: false,
  onToggleExpanded: vi.fn(),
  onClose: vi.fn(),
  recState: 'idle' as const,
  elapsedSeconds: 0,
  onStartRecording: vi.fn(),
  onStopRecording: vi.fn(),
};
const recording = (id: string, number: number): RecordingLog => ({
  id,
  number,
  day: '',
  time: '',
  durationMs: 1000,
  lines: [],
  folded: false,
});

it.each([
  { isRecording: true, isFinishing: true, recState: 'stopping' as const },
  { isFinishing: true },
  { recState: 'stopping' as const },
  { finishedRecordingId: 'pending' },
])('shows finishing progress only in the footer for %j', props => {
  render(<TranscriptPanel {...base} {...props} />);
  const body = within(screen.getByTestId('transcript-body'));
  expect(body.queryByRole('status')).toBeNull();
  expect(screen.getAllByText('recording.panel.finishing')).toHaveLength(1);
  expect(body.queryByText('recording.panel.empty')).toBeNull();
  expect(body.queryByText('recording.panel.listeningInitial')).toBeNull();
});

it('does not invent a recording number in the away panel', () => {
  render(<TranscriptPanel {...base} isRecording recState="recording" onOpenNote={vi.fn()} />);
  const body = within(screen.getByTestId('transcript-body'));
  expect(body.getByText('recording.panel.title')).toBeTruthy();
  expect(body.queryByText(/recording.panel.recordingNumber/)).toBeNull();
});

it('keeps listening and paused indicators in the live transcript area', () => {
  const view = render(<TranscriptPanel {...base} isRecording recState="recording" />);
  const body = within(screen.getByTestId('transcript-body'));
  expect(body.getByRole('status').textContent).toContain('recording.panel.listeningInitial');
  const liveLines = [{ id: 'line', at: '20:31', speaker: 'You', text: 'Hello' }];
  view.rerender(<TranscriptPanel {...base} isRecording recState="recording" liveLines={liveLines} />);
  expect(body.getByRole('status').textContent).toContain('recording.panel.listening');
  view.rerender(<TranscriptPanel {...base} isRecording isPaused recState="paused" liveLines={liveLines} />);
  expect(body.getByRole('status').textContent).toContain('recording.panel.paused');
});

it('keeps historical dividers and renders the active recording only once', () => {
  render(
    <TranscriptPanel
      {...base}
      isRecording
      isFinishing
      activeRecordingId="new"
      recordings={[recording('new', 2), recording('old', 1)]}
    />
  );
  const body = within(screen.getByTestId('transcript-body'));
  expect(body.getAllByText('recording.panel.recordingNumber 1')).toHaveLength(1);
  expect(body.getAllByText('recording.panel.recordingNumber 2')).toHaveLength(1);
});

it('shows processing instead of the empty state with zero transcript lines', () => {
  render(<TranscriptPanel {...base} recordings={[{ ...recording('new', 1), processing: true }]} />);
  const body = within(screen.getByTestId('transcript-body'));
  expect(body.getByRole('status').textContent).toContain('recording.panel.transcribing');
  expect(body.queryByText('recording.panel.empty')).toBeNull();
});

it('hands off from saving to speaker identification without overlapping phases', () => {
  const logs = [{ ...recording('new', 1), processing: true,
    lines: [{ id: 'line', speaker: 'You', at: '20:31', text: 'Hello, is this working?' }] }];
  const view = render(<TranscriptPanel {...base} isFinishing activeRecordingId="new"
    recordings={logs} finishedRecordingId="new" />);
  const body = within(screen.getByTestId('transcript-body'));
  expect(body.queryByRole('status')).toBeNull();
  expect(screen.getAllByText('recording.panel.finishing')).toHaveLength(1);
  view.rerender(<TranscriptPanel {...base} activeRecordingId="new"
    recordings={logs} finishedRecordingId="new" />);
  expect(body.getAllByRole('status')).toHaveLength(1);
  expect(body.getByRole('status').textContent).toContain('recording.panel.identifyingSpeakers');
});

it('returns a finalized silent recording directly to Start', () => {
  render(<TranscriptPanel {...base} finishedRecordingId="silent"
    recordings={[{ ...recording('silent', 2), linesLoaded: true, processing: false }]} />);
  const start = screen.getByRole('button', { name: 'recording.actions.start' });
  expect(start.getAttribute('aria-disabled')).toBe('false');
  fireEvent.click(start);
  expect(base.onStartRecording).toHaveBeenCalledOnce();
  expect(screen.queryByText('recording.panel.transcriptReady')).toBeNull();
  expect(screen.queryByRole('button', { name: 'common.actions.close' })).toBeNull();
});

it('keeps active enhancement status in the footer while the transcript settles', () => {
  const status = vi.fn(() => <button>Stop Enhance</button>);
  const view = render(<TranscriptPanel {...base} isFinishing skillStatus={status} />);
  expect(status).toHaveBeenLastCalledWith(null, true);
  const stop = screen.getByRole('button', { name: 'Stop Enhance' });
  view.rerender(<TranscriptPanel {...base} finishedRecordingId="new"
    recordings={[{ ...recording('new', 2), processing: true }]} skillStatus={status} />);
  expect(status).toHaveBeenLastCalledWith(null, true);
  expect(screen.getByRole('button', { name: 'Stop Enhance' })).toBe(stop);
  const ready = { ...recording('new', 2), processing: false,
    lines: [{ id: 'line', at: '20:53', speaker: 'You', text: 'Transcript' }] };
  view.rerender(<TranscriptPanel {...base} finishedRecordingId="new" isFinishing
    recordings={[ready]} skillStatus={status} />);
  expect(status).toHaveBeenLastCalledWith(null, true);
  view.rerender(<TranscriptPanel {...base} finishedRecordingId="new"
    recordings={[ready]} skillStatus={status} />);
  expect(screen.getByRole('button', { name: 'Stop Enhance' })).toBe(stop);
});

it('does not expose the ready Enhance action while the client is still finishing', () => {
  const ready = { ...recording('new', 1), processing: false,
    lines: [{ id: 'line', at: '20:53', speaker: 'You', text: 'Transcript' }] };
  const view = render(<TranscriptPanel {...base} isFinishing finishedRecordingId="new"
    recordings={[ready]} />);
  expect(screen.queryByRole('button', { name: /recording.skill.enhanceLabel/ })).toBeNull();
  view.rerender(<TranscriptPanel {...base} finishedRecordingId="new" recordings={[ready]} />);
  expect(screen.getByRole('button', { name: /recording.skill.enhanceLabel/ })).toBeTruthy();
});

it('shows an inert Start button while a finished recording has a suggestion to review', () => {
  const start = vi.fn();
  render(<TranscriptPanel {...base} onStartRecording={start} finishedRecordingId="review"
    startBlockedReason="Apply or discard the suggested changes before recording."
    recordings={[{ ...recording('review', 1), linesLoaded: true, processing: false }]} />);
  const button = screen.getByRole('button', { name: 'recording.actions.start' });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button);
  expect(start).not.toHaveBeenCalled();
});

it('exposes startup as a pending tour target only until capture settles', () => {
  const view = render(<TranscriptPanel {...base} recState="starting" />);
  expect(view.container.querySelector('[data-onboarding="record-pending"]')).not.toBeNull();
  expect(
    screen.getByRole('button', { name: 'recording.actions.stop' }).hasAttribute('disabled')
  ).toBe(true);
  view.rerender(<TranscriptPanel {...base} isRecording recState="recording" />);
  expect(view.container.querySelector('[data-onboarding="record-pending"]')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'recording.actions.stop' }).hasAttribute('disabled')
  ).toBe(false);
  view.rerender(<TranscriptPanel {...base} recState="idle" />);
  expect(view.container.querySelector('[data-onboarding="record-start"]')).not.toBeNull();
});

it('provides a waiting target until finalization and a retry target for silent output', () => {
  const view = render(<TranscriptPanel {...base} recState="stopping" isFinishing />);
  expect(view.container.querySelector('[data-onboarding="record-saving"]')).not.toBeNull();
  view.rerender(<TranscriptPanel {...base} finishedRecordingId="new" recordings={[{...recording('new',1), processing:true}]} />);
  expect(view.container.querySelector('[data-onboarding="transcript-wait"]')).not.toBeNull();
  view.rerender(<TranscriptPanel {...base} finishedRecordingId="new" recordings={[{...recording('new',1), linesLoaded:true, processing:false}]} />);
  expect(view.container.querySelector('[data-onboarding="record-retry"]')).not.toBeNull();
  expect(screen.getByRole('button',{name:'recording.actions.start'})).toBeTruthy();
});

const line = (id: string, speakerKey: string, speaker: string, text = 'hello') => ({
  id,
  speaker,
  speakerKey,
  at: '',
  text,
});

it('renders a flagged owner on the right, named for a viewer who is not the owner', () => {
  const rec: RecordingLog = {
    ...recording('rec_1', 1),
    lines: [line('l1', 'dz:0', 'recording.panel.speakerNumber 1'), line('l2', 'dz:1', 'recording.panel.speakerNumber 2')],
    speakers: [
      { id: 's0', speakerKey: 'dz:0', displayName: null },
      { id: 's1', speakerKey: 'dz:1', displayName: null, isOwner: true, source: 'user' },
    ],
    owner: { isViewer: false, name: 'Naomi Chopra', email: null, image: null },
    canTag: true,
  };
  render(<TranscriptPanel {...base} recordings={[rec]} onTagSpeaker={vi.fn()} />);
  const ownerLabel = screen.getByText('Naomi Chopra');
  expect(ownerLabel.closest('.self-end')).not.toBeNull();
  expect(screen.getByText('recording.panel.speakerNumber 1').closest('.self-start')).not.toBeNull();
  expect(screen.queryByText('recording.panel.you')).toBeNull();
});

it('offers "This is me" on other speakers and "Not me" on the owner, calling the tag handler by key', () => {
  const onTagSpeaker = vi.fn();
  const rec: RecordingLog = {
    ...recording('rec_1', 1),
    lines: [line('l1', 'dz:0', 'recording.panel.speakerNumber 1'), line('l2', 'you', 'recording.panel.you')],
    speakers: [{ id: 's0', speakerKey: 'dz:0', displayName: 'Ana' }],
    canTag: true,
  };
  render(<TranscriptPanel {...base} recordings={[rec]} onTagSpeaker={onTagSpeaker} />);
  fireEvent.click(screen.getByRole('menuitem', { name: 'recording.panel.thisIsMe' }));
  expect(onTagSpeaker).toHaveBeenCalledWith('rec_1', 'dz:0', { isOwner: true });
  fireEvent.click(screen.getByRole('menuitem', { name: 'recording.panel.notMe' }));
  expect(onTagSpeaker).toHaveBeenCalledWith('rec_1', 'you', { isOwner: false });
  fireEvent.click(screen.getByRole('menuitem', { name: 'recording.panel.clearName' }));
  expect(onTagSpeaker).toHaveBeenCalledWith('rec_1', 'dz:0', { displayName: null, personId: null });
});

it('renames through the menu and commits by key', () => {
  const onTagSpeaker = vi.fn();
  const rec: RecordingLog = {
    ...recording('rec_1', 1),
    lines: [line('l1', 'dz:0', 'recording.panel.speakerNumber 1')],
    speakers: [{ id: 's0', speakerKey: 'dz:0', displayName: null }],
    canTag: true,
  };
  render(<TranscriptPanel {...base} recordings={[rec]} onTagSpeaker={onTagSpeaker} />);
  fireEvent.click(screen.getByRole('menuitem', { name: 'recording.actions.renameSpeaker' }));
  const input = screen.getByLabelText('recording.panel.speakerName');
  fireEvent.change(input, { target: { value: '  Robert Ray ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onTagSpeaker).toHaveBeenCalledWith('rec_1', 'dz:0', { displayName: 'Robert Ray' });
});

it('hides the menu without write access and honours "Not me" on the mic channel', () => {
  const rec: RecordingLog = {
    ...recording('rec_1', 1),
    lines: [line('l1', 'you', 'recording.panel.you')],
    speakers: [{ id: 's0', speakerKey: 'you', displayName: 'Guest', isOwner: false, source: 'user' }],
    canTag: false,
  };
  render(<TranscriptPanel {...base} recordings={[rec]} onTagSpeaker={vi.fn()} />);
  expect(screen.queryByRole('menuitem')).toBeNull();
  expect(screen.getByText('Guest').closest('.self-start')).not.toBeNull();
});

it('asks which speaker is you only for an unresolved diarized recording, and can be dismissed', () => {
  const unresolved: RecordingLog = {
    ...recording('rec_1', 1),
    lines: [line('l1', 'dz:0', 'S1'), line('l2', 'dz:1', 'S2')],
    speakers: [
      { id: 's0', speakerKey: 'dz:0', displayName: null },
      { id: 's1', speakerKey: 'dz:1', displayName: null },
    ],
    canTag: true,
  };
  const { rerender } = render(<TranscriptPanel {...base} recordings={[unresolved]} onTagSpeaker={vi.fn()} />);
  expect(screen.getByRole('note').textContent).toContain('recording.panel.whichOneIsYou');
  fireEvent.click(screen.getByRole('button', { name: 'recording.panel.dismissHint' }));
  expect(screen.queryByRole('note')).toBeNull();

  const resolved: RecordingLog = {
    ...unresolved,
    id: 'rec_2',
    speakers: [...unresolved.speakers!.slice(0, 1), { id: 's1', speakerKey: 'dz:1', displayName: null, isOwner: true }],
  };
  rerender(<TranscriptPanel {...base} recordings={[resolved]} onTagSpeaker={vi.fn()} />);
  expect(screen.queryByRole('note')).toBeNull();
});

it('opens the person picker from the menu and tags the speaker with the picked person', () => {
  const onTagSpeaker = vi.fn();
  const rec: RecordingLog = {
    ...recording('rec_1', 1),
    lines: [line('l1', 'dz:0', 'recording.panel.speakerNumber 1')],
    speakers: [{ id: 's0', speakerKey: 'dz:0', displayName: null }],
    canTag: true,
  };
  render(<TranscriptPanel {...base} recordings={[rec]} onTagSpeaker={onTagSpeaker} />);
  fireEvent.click(screen.getByRole('menuitem', { name: 'recording.panel.tagPerson' }));
  fireEvent.click(screen.getByText('pick-person'));
  expect(onTagSpeaker).toHaveBeenCalledWith('rec_1', 'dz:0', { personId: 'prs_pick' });
  expect(screen.queryByText('pick-person')).toBeNull();
});

it('clears a linked person together with the name', () => {
  const onTagSpeaker = vi.fn();
  const rec: RecordingLog = {
    ...recording('rec_1', 1),
    lines: [line('l1', 'dz:0', 'recording.panel.speakerNumber 1')],
    speakers: [{ id: 's0', speakerKey: 'dz:0', displayName: 'Ana', personId: 'prs_a' }],
    canTag: true,
  };
  render(<TranscriptPanel {...base} recordings={[rec]} onTagSpeaker={onTagSpeaker} />);
  fireEvent.click(screen.getByRole('menuitem', { name: 'recording.panel.clearName' }));
  expect(onTagSpeaker).toHaveBeenCalledWith('rec_1', 'dz:0', { displayName: null, personId: null });
});

it('never offers "This is me" to a collaborator who is not the recording owner', () => {
  const rec: RecordingLog = {
    ...recording('rec_1', 1),
    lines: [line('l1', 'dz:0', 'S1'), line('l2', 'you', 'You')],
    speakers: [{ id: 's0', speakerKey: 'dz:0', displayName: null }],
    owner: { isViewer: false, name: 'Naomi Chopra', email: null, image: null },
    canTag: true,
  };
  render(<TranscriptPanel {...base} recordings={[rec]} onTagSpeaker={vi.fn()} />);
  expect(screen.queryByRole('menuitem', { name: 'recording.panel.thisIsMe' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'recording.panel.notMe' })).toBeNull();
  expect(screen.getAllByRole('menuitem', { name: 'recording.actions.renameSpeaker' }).length).toBeGreaterThan(0);
});


it('keeps local speaker names and owner controls without directory actions', () => {
  capabilities.featureFlags = { directory: false };
  try {
    const rec: RecordingLog = { ...recording('rec_local', 1), lines: [line('local_turn', 'you', 'You')], canTag: true };
    const onTagSpeaker = vi.fn();
    render(<TranscriptPanel {...base} recordings={[rec]} onTagSpeaker={onTagSpeaker} />);
    expect(screen.queryByRole('menuitem', { name: 'recording.panel.tagPerson' })).toBeNull();
    expect(screen.queryByText('pick-person')).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'recording.actions.renameSpeaker' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'recording.panel.notMe' }));
    expect(onTagSpeaker).toHaveBeenCalledWith('rec_local', 'you', { isOwner: false });
  } finally {
    capabilities.featureFlags = null;
  }
});

it('keeps the recording chip after the post-stop bar returns to Start', () => {
  vi.useFakeTimers();
  try {
    const ready = { ...recording('new', 1), processing: false, linesLoaded: true,
      lines: [{ id: 'line', at: '20:53', speaker: 'You', text: 'Transcript' }] };
    render(<TranscriptPanel {...base} finishedRecordingId="new" recordings={[ready]} />);
    expect(screen.getByText('recording.panel.transcriptReady')).toBeTruthy();
    expect(screen.getByRole('button', { name: /recording.skill.enhanceLabel/ })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(9_000); });
    expect(screen.queryByText('recording.panel.transcriptReady')).toBeNull();
    expect(screen.getByRole('button', { name: 'recording.actions.start' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /recording.skill.enhanceLabel/ })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it('offers the chip on a revisit, from the newest pending recording alone', () => {
  const onEnhanceRecording = vi.fn();
  const ready = (id: string, number: number, folded = false) => ({ ...recording(id, number),
    processing: false, linesLoaded: true, folded,
    lines: [{ id: `${id}-line`, at: '20:53', speaker: 'You', text: 'Transcript' }] });
  const view = render(<TranscriptPanel {...base} onEnhanceRecording={onEnhanceRecording}
    recordings={[ready('new', 2), ready('old', 1)]} />);
  fireEvent.click(screen.getByRole('button', { name: /recording.skill.enhanceLabel/ }));
  expect(onEnhanceRecording).toHaveBeenCalledWith('new');
  view.rerender(<TranscriptPanel {...base} onEnhanceRecording={onEnhanceRecording}
    recordings={[ready('new', 2, true), ready('old', 1)]} />);
  expect(screen.queryByRole('button', { name: /recording.skill/ })).toBeNull();
});

it('says Generate notes on an empty body and hides while a suggestion blocks recording', () => {
  const ready = { ...recording('new', 1), processing: false, linesLoaded: true,
    lines: [{ id: 'line', at: '20:53', speaker: 'You', text: 'Transcript' }] };
  const view = render(<TranscriptPanel {...base} recordings={[ready]} noteBodyEmpty />);
  const chip = screen.getByRole('button', { name: /recording.skill.generateLabel/ });
  expect(chip.getAttribute('title')).toBe('recording.skill.generateHint');
  view.rerender(<TranscriptPanel {...base} recordings={[ready]} noteBodyEmpty={false}
    startBlockedReason="Apply or discard the suggested changes before recording." />);
  expect(screen.queryByRole('button', { name: /recording.skill/ })).toBeNull();
});
