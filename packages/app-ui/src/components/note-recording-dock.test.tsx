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
