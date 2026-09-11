// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpokenLanguageLink } from './spoken-language-link';

const state = { desktop: false, language: 'de' as string | undefined };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { language?: string }) =>
      opts?.language ? `${key}:${opts.language}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => ({ has: () => state.desktop }),
  useTranscriptionPreference: () => ({ language: state.language }),
  usePorts: () => ({ navigation: { Link: 'a' } }),
}));

afterEach(() => {
  cleanup();
  state.desktop = false;
  state.language = 'de';
});

describe('SpokenLanguageLink', () => {
  it('shows the current language by name and links to the transcription settings', () => {
    render(<SpokenLanguageLink />);
    expect(screen.getByText('settings.transcription.language.label')).toBeTruthy();
    expect(screen.getByText(/settings\.preferences\.spokenLanguage\.current:German/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /settings\.preferences\.spokenLanguage\.open/ });
    expect(link.getAttribute('href')).toBe('/settings/transcription');
  });

  it('omits the current value while the account preference is unknown', () => {
    state.language = undefined;
    render(<SpokenLanguageLink />);
    expect(screen.queryByText(/spokenLanguage\.current/)).toBeNull();
    expect(screen.getByRole('link')).toBeTruthy();
  });

  it('shows the same transcription settings link on desktop', () => {
    state.desktop = true;
    render(<SpokenLanguageLink />);
    expect(screen.getByText(/spokenLanguage\.current:German/)).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/settings/transcription');
  });
});
