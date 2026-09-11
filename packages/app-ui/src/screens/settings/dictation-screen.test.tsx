// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionScreen } from './dictation-screen';

const state = vi.hoisted(() => ({
  desktop: false,
  setLanguage: vi.fn(),
  microphoneDevices: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@prismical/app-client', () => ({
  TRANSCRIPTION_LANGUAGE_CODES: ['en', 'de', 'fr'],
  DEFAULT_MICROPHONE_DEVICE_ID: 'default',
  useDesktopCapabilities: () => ({ has: () => state.desktop }),
  useMicrophoneDevices: (enabled: boolean) => {
    state.microphoneDevices(enabled);
    return [{ deviceId: 'default', label: 'System microphone', isDefault: true }];
  },
  useRecordingPreferences: () => [{ microphonePriority: [] }, vi.fn()],
  useTranscriptionPreference: () => ({ language: 'de', setLanguage: state.setLanguage }),
  resolveActiveMicrophone: () => 'default',
  mergeConnectedMicrophones: vi.fn(),
  promoteMicrophone: vi.fn(),
}));
beforeEach(() => {
  state.desktop = false;
  state.setLanguage.mockReset().mockResolvedValue(undefined);
  state.microphoneDevices.mockClear();
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TranscriptionScreen', () => {
  it('keeps the web microphone picker beside the spoken language choice', () => {
    render(<TranscriptionScreen />);
    expect(screen.getByRole('button', { name: 'settings.transcription.language.aria' }).textContent).toContain('German');
    expect(screen.getByLabelText('settings.transcription.microphoneLabel')).toBeTruthy();
    expect(state.microphoneDevices).toHaveBeenCalledWith(true);
  });

  it('shows the desktop spoken choice and engine settings without the web microphone picker', async () => {
    state.desktop = true;
    render(<TranscriptionScreen engineSettings={<div>Native engine controls</div>} />);
    expect(screen.getByText('Native engine controls')).toBeTruthy();
    expect(screen.getByText('settings.transcription.nextRecording')).toBeTruthy();
    expect(screen.queryByLabelText('settings.transcription.microphoneLabel')).toBeNull();
    expect(state.microphoneDevices).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'settings.transcription.language.aria' }));
    fireEvent.click(screen.getByRole('option', { name: 'French' }));
    await waitFor(() => expect(state.setLanguage).toHaveBeenCalledWith('fr'));
  });
});
