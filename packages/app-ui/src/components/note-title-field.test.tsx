// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import type { Note } from '@prismical/app-contracts';
import { I18nextProvider } from 'react-i18next';
import { CurrentEditorProvider } from '../shell/current-editor-context';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  run: vi.fn(),
  dirty: vi.fn(),
  transcript: false,
}));
vi.mock('@prismical/app-client', () => ({
  useUpdateNote: () => ({ mutate: mocks.update }),
  useSkillsList: () => ({
    data: [
      {
        id: 'skl_name_note',
        name: 'Name note',
        system: true,
        enabled: true,
        config: { outputTarget: 'note-title' },
      },
    ],
  }),
  useRunSkill: () => ({ running: false, run: mocks.run, cancel: vi.fn() }),
  setTitleDraftDirty: mocks.dirty,
  useTitleTranscriptAvailable: () => ({ data: mocks.transcript }),
}));
const { NoteTitleField } = await import('./note-title-field');
const i18n = createApplicationI18nSync('en');
const base = {
  id: 'nt_test',
  title: 'Untitled note',
  titleSource: 'placeholder',
  body: '',
  writable: true,
} as Note;
function field(note: Note = base, compact = false) {
  return (
    <I18nextProvider i18n={i18n}>
      <CurrentEditorProvider>
        <NoteTitleField note={note} compact={compact} />
      </CurrentEditorProvider>
    </I18nextProvider>
  );
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.transcript = false;
});

describe('NoteTitleField', () => {
  it('shows a placeholder and disables AI until content exists', () => {
    render(field());
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Untitled note');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button'));
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('follows the first body line without issuing manual rename writes', () => {
    const view = render(field({ ...base, body: '# Roadmap\n\nMore' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Roadmap');
    view.rerender(field({ ...base, body: '# Updated roadmap' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Updated roadmap');
    fireEvent.blur(screen.getByRole('textbox'));
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('preserves a dirty title across remote changes and commits it on blur', () => {
    const view = render(field({ ...base, body: 'Roadmap' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My own title' } });
    view.rerender(field({ ...base, title: 'Remote AI title', titleSource: 'ai', body: 'Roadmap' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('My own title');
    fireEvent.blur(screen.getByRole('textbox'));
    expect(mocks.update).toHaveBeenCalledWith({ title: 'My own title' });
  });
  it('Escape cancels editing and clearing a title requests default naming', () => {
    render(field({ ...base, title: 'Explicit', titleSource: 'manual' }));
    const input = screen.getByRole('textbox');
    input.focus();
    fireEvent.change(input, { target: { value: 'Discard' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('Explicit');
    expect(mocks.update).not.toHaveBeenCalled();
    input.focus();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(mocks.update).toHaveBeenCalledWith({ title: '' });
  });
  it.each([false, true])('runs the same built-in title skill from compact=%s', compact => {
    mocks.transcript = true;
    render(field(base, compact));
    fireEvent.click(screen.getByRole('button'));
    expect(mocks.run).toHaveBeenCalledWith({
      skillId: 'skl_name_note',
      skillName: 'Name note',
      outputTarget: 'note-title',
    });
  });
  it('keeps calendar names and read-only names intact', () => {
    render(
      field({
        ...base,
        title: 'Full calendar meeting title',
        titleSource: 'calendar',
        body: 'Other line',
        writable: false,
      })
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(
      'Full calendar meeting title'
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
