// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

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
  useSessionView: () => ({ accounts: [], activeSub: null }),
  useViewerProfile: () => ({ data: null }),
  useAutoEnhanceStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('./note-recording-dock', () => ({ formatSessionTimer: () => '0:00' }));
vi.mock('./dock-mic-menu', () => ({ DockMicMenu: () => null }));
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
  expect(screen.queryByRole('button', { name: /recording.panel.enhanceChip/ })).toBeNull();
  view.rerender(<TranscriptPanel {...base} finishedRecordingId="new" recordings={[ready]} />);
  expect(screen.getByRole('button', { name: /recording.panel.enhanceChip/ })).toBeTruthy();
});

it('shows an inert Start button while a finished recording has a suggestion to review', () => {
  const start = vi.fn();
  render(<TranscriptPanel {...base} onStartRecording={start} finishedRecordingId="review"
    startBlockedReason="Keep or undo the suggested changes before recording."
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
