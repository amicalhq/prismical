// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockMicMenu } from './dock-mic-menu';

const state = vi.hoisted(() => ({ language: 'de', setLanguage: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { language?: string }) => opts?.language ? `${key}:${opts.language}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@prismical/app-client', () => ({
  TRANSCRIPTION_LANGUAGE_CODES: ['en', 'de', 'fr'],
  useMicrophoneDevices: () => [],
  useNavigation: () => ({ push: vi.fn() }),
  useRecordingPreferences: () => [{ microphonePriority: [] }, vi.fn()],
  useTranscriptionPreference: () => ({ language: state.language, setLanguage: state.setLanguage }),
  resolveActiveMicrophone: () => 'default',
  promoteMicrophone: vi.fn(),
}));
beforeEach(() => {
  state.language = 'de';
  state.setLanguage.mockReset().mockResolvedValue(undefined);
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
const pickFrench = () => {
  fireEvent.click(screen.getByTestId('recording-language-chip'));
  fireEvent.click(screen.getByRole('option', { name: 'French' }));
};

describe('DockMicMenu spoken language', () => {
  it('uses the saved default without an active recording language', () => {
    render(<DockMicMenu />);
    expect(screen.getByTestId('recording-language-chip').textContent).toContain('German');
  });

  it('shows the active recording language even when the saved default changes', () => {
    const view = render(<DockMicMenu activeLanguage="en" />);
    expect(screen.getByTestId('recording-language-chip').textContent).toContain('English');
    state.language = 'fr';
    view.rerender(<DockMicMenu activeLanguage="en" />);
    expect(screen.getByTestId('recording-language-chip').textContent).toContain('English');
  });

  it('saves first and keeps a pending choice bound to the initiating recording callback', async () => {
    let resolveSave!: () => void;
    state.setLanguage.mockImplementation(() => new Promise<void>(resolve => { resolveSave = resolve; }));
    const onChangeLanguage = vi.fn().mockResolvedValue(undefined);
    const replacementCallback = vi.fn();
    const view = render(<DockMicMenu activeLanguage="en" onChangeLanguage={onChangeLanguage} />);
    pickFrench();
    expect(state.setLanguage).toHaveBeenCalledWith('fr');
    expect(onChangeLanguage).not.toHaveBeenCalled();
    view.rerender(<DockMicMenu activeLanguage="de" onChangeLanguage={replacementCallback} />);
    await act(async () => { resolveSave(); });
    expect(onChangeLanguage).toHaveBeenCalledWith('fr');
    expect(replacementCallback).not.toHaveBeenCalled();
  });

  it('keeps the actual recording language after a failed active change', async () => {
    state.setLanguage.mockImplementation(async (language: string) => { state.language = language; });
    const onChangeLanguage = vi.fn().mockRejectedValue(new Error('Language unavailable'));
    const view = render(<DockMicMenu activeLanguage="en" onChangeLanguage={onChangeLanguage} />);
    pickFrench();
    await waitFor(() => expect(onChangeLanguage).toHaveBeenCalledWith('fr'));
    view.rerender(<DockMicMenu activeLanguage="en" onChangeLanguage={onChangeLanguage} />);
    expect(state.language).toBe('fr');
    expect(screen.getByTestId('recording-language-chip').textContent).toContain('English');
  });

  it('keeps the active recording unchanged if saving the account choice fails', async () => {
    state.setLanguage.mockRejectedValue(new Error('Save failed'));
    const onChangeLanguage = vi.fn();
    render(<DockMicMenu activeLanguage="en" onChangeLanguage={onChangeLanguage} />);
    pickFrench();
    await act(async () => {});
    expect(onChangeLanguage).not.toHaveBeenCalled();
    expect(screen.getByTestId('recording-language-chip').textContent).toContain('English');
  });
});
