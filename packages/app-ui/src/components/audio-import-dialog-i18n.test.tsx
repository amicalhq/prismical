// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import { AudioImportDialog } from './audio-import-dialog';

vi.mock('@prismical/app-client', () => ({
  useTranscriptionPreference: () => ({ language: 'en' }),
  currentTranscriptionLanguage: () => 'en',
  TRANSCRIPTION_LANGUAGE_CODES: ['en'],
}));
afterEach(cleanup);
it.each([
  ['en', 'Supported formats: MP3, WAV, M4A/MP4 and more'],
  ['ja', '対応形式：MP3、WAV、M4A/MP4、その他'],
  ['zh-TW', '支援的格式：MP3、WAV、M4A/MP4 及更多'],
])('renders the complete %s sentence with its own punctuation', async (locale, sentence) => {
  const i18n = await createApplicationI18n(locale);
  render(
    <I18nextProvider i18n={i18n}>
      <AudioImportDialog
        open
        onOpenChange={vi.fn()}
        onImport={vi.fn()}
        maxRecordingSeconds={3600}
      />
    </I18nextProvider>
  );
  expect(screen.getByRole('dialog').textContent).toContain(sentence);
});
