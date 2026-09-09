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

it('shows finishing progress inside the live body after Stop', () => {
  render(<TranscriptPanel {...base} isRecording isFinishing recState="stopping" />);
  const body = within(screen.getByTestId('transcript-body'));
  expect(body.getByRole('status').textContent).toContain('recording.panel.finishing');
  expect(body.queryByText('recording.panel.empty')).toBeNull();
  expect(body.queryByText('recording.panel.listeningInitial')).toBeNull();
});

it('does not invent a recording number in the away panel', () => {
  render(<TranscriptPanel {...base} isRecording recState="recording" onOpenNote={vi.fn()} />);
  const body = within(screen.getByTestId('transcript-body'));
  expect(body.getByText('recording.panel.title')).toBeTruthy();
  expect(body.queryByText(/recording.panel.recordingNumber/)).toBeNull();
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

it('suppresses previous completed skill results throughout finishing', () => {
  const status = vi.fn(() => null);
  const view = render(<TranscriptPanel {...base} isFinishing skillStatus={status} />);
  expect(status).toHaveBeenLastCalledWith(null, true);
  view.rerender(<TranscriptPanel {...base} finishedRecordingId="new"
    recordings={[{ ...recording('new', 2), processing: true }]} skillStatus={status} />);
  expect(status).toHaveBeenLastCalledWith(null, true);
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
