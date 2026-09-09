// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./waveform', () => ({ Waveform: () => null }));

import { RecordingPillFace } from './note-recording-dock';

afterEach(cleanup);

it.each([
  [false, 'recording.actions.showTranscription'],
  [true, 'recording.actions.hideTranscription'],
] as const)('allows toggling the transcript during review (open=%s)', (isPanelOpen, label) => {
  const toggle = vi.fn();
  render(
    <RecordingPillFace
      recState="idle"
      isPanelOpen={isPanelOpen}
      startBlockedReason="Review the suggestion before recording"
      onTogglePanel={toggle}
      onStopRecording={vi.fn()}
      elapsedSeconds={0}
    />
  );
  const button = screen.getByRole('button', { name: label });
  expect(button.getAttribute('aria-disabled')).not.toBe('true');
  fireEvent.click(button);
  expect(toggle).toHaveBeenCalledOnce();
});

it('keeps a pending anchor on the collapsed dock until startup settles', () => {
  const props = {
    isPanelOpen: false,
    onTogglePanel: vi.fn(),
    onStopRecording: vi.fn(),
    elapsedSeconds: 0,
  };
  const view = render(<RecordingPillFace {...props} recState="starting" />);
  const pending = view.container.querySelector('[data-onboarding="record-pending"]');
  expect(pending).not.toBeNull();
  expect(pending?.closest('[inert], [aria-hidden="true"]')).toBeNull();
  view.rerender(<RecordingPillFace {...props} recState="recording" />);
  expect(view.container.querySelector('[data-onboarding="record-pending"]')).toBeNull();
  view.rerender(<RecordingPillFace {...props} recState="idle" />);
  expect(screen.getByRole('button', { name: 'recording.actions.start' }).dataset.onboarding).toBe(
    'record-open'
  );
});

it('anchors Stop to Stop rather than Pause in the collapsed recording controls', () => {
  const stop = vi.fn();
  render(
    <RecordingPillFace
      recState="recording"
      canPause
      isPanelOpen={false}
      onTogglePanel={vi.fn()}
      onStopRecording={stop}
      onPauseRecording={vi.fn()}
      elapsedSeconds={5}
    />
  );
  const target = document.querySelector('[data-onboarding="record-stop"]');
  expect(target).toBe(screen.getByRole('button', { name: 'recording.actions.stop' }));
  fireEvent.click(target!);
  expect(stop).toHaveBeenCalledOnce();
});
