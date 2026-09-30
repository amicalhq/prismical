// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AudioImportDialog } from './audio-import-dialog';
vi.mock('./audio-import-validation', async importOriginal => ({
  ...(await importOriginal<typeof import('./audio-import-validation')>()),
  validateImportFile: vi.fn(),
}));
import { validateImportFile } from './audio-import-validation';
const preference = vi.hoisted(() => ({ language: 'ja' }));
vi.mock('@prismical/app-client', () => ({
  useTranscriptionPreference: () => preference,
  currentTranscriptionLanguage: () => 'en',
  TRANSCRIPTION_LANGUAGE_CODES: ['en', 'ja', 'de'],
}));
vi.mock('react-i18next', () => ({
  Trans: ({ components }: { components: { more: React.ReactElement } }) =>
    React.cloneElement(components.more, {}, 'more'),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('offers language for a new import but hides it when replacing audio', () => {
  const props = { open: true, onOpenChange: vi.fn(), onImport: vi.fn(), maxRecordingSeconds: 3600 };
  const view = render(<AudioImportDialog {...props} />);
  expect(screen.getByRole('combobox', { name: 'audioImport.language' })).toBeTruthy();
  view.rerender(<AudioImportDialog {...props} isRestart />);
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('removing a file during validation prevents the stale result from enabling import', async () => {
  let complete!: () => void;
  vi.mocked(validateImportFile).mockImplementation(
    () =>
      new Promise<void>(resolve => {
        complete = resolve;
      })
  );
  render(
    <AudioImportDialog open onOpenChange={vi.fn()} onImport={vi.fn()} maxRecordingSeconds={3600} />
  );
  const file = new File(['audio'], 'meeting.mp3', { type: 'audio/mpeg' });
  fireEvent.change(screen.getByLabelText('audioImport.file'), { target: { files: [file] } });
  expect(screen.getByText('meeting.mp3')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'ai.attachments.remove' }));
  await act(async () => {
    complete();
  });
  expect(screen.queryByText('meeting.mp3')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'audioImport.submit' }) as HTMLButtonElement).disabled
  ).toBe(true);
  expect((screen.getByLabelText('audioImport.file') as HTMLInputElement).value).toBe('');
});

it('defaults to the account spoken language and refreshes it when reopened', () => {
  preference.language = 'ja';
  const props = { open: true, onOpenChange: vi.fn(), onImport: vi.fn(), maxRecordingSeconds: 3600 };
  const view = render(<AudioImportDialog {...props} />);
  expect(screen.getByRole('combobox', { name: 'audioImport.language' }).textContent).toContain(
    'Japanese'
  );
  view.rerender(<AudioImportDialog {...props} open={false} />);
  preference.language = 'de';
  view.rerender(<AudioImportDialog {...props} />);
  expect(screen.getByRole('combobox', { name: 'audioImport.language' }).textContent).toContain(
    'German'
  );
});

it('shows format details in a tooltip on keyboard focus', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  render(
    <AudioImportDialog open onOpenChange={vi.fn()} onImport={vi.fn()} maxRecordingSeconds={3600} />
  );
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.focus(
    screen.getByRole('button', { name: 'audioImport.moreFormats (audioImport.supportedFormats)' })
  );
  expect((await screen.findByRole('tooltip')).textContent).toContain('audioImport.formatDetails');
});

it.each(['flac', 'ogg', 'oga', 'opus', 'webm', 'aac'])(
  'accepts a validated %s file',
  async extension => {
    vi.mocked(validateImportFile).mockResolvedValue(undefined);
    const onImport = vi.fn();
    render(
      <AudioImportDialog
        open
        onOpenChange={vi.fn()}
        onImport={onImport}
        maxRecordingSeconds={3600}
      />
    );
    const input = screen.getByLabelText('audioImport.file');
    expect(input.getAttribute('accept')?.split(',')).toContain(`.${extension}`);
    const file = new File(['audio'], `meeting.${extension}`);
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'audioImport.submit' }));
    expect(onImport).toHaveBeenCalledWith(file, preference.language);
  }
);

it('opens format details on tap/click', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  render(
    <AudioImportDialog open onOpenChange={vi.fn()} onImport={vi.fn()} maxRecordingSeconds={3600} />
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'audioImport.moreFormats (audioImport.supportedFormats)' })
  );
  expect((await screen.findByRole('tooltip')).textContent).toContain('audioImport.formatDetails');
});
