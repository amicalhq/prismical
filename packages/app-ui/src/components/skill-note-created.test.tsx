// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  undo: vi.fn(),
  editor: { id: 'current-editor' },
  notice: null as null | { noteId: string; ownerKey: string; orgId: string; undoPending?: boolean; undo: ReturnType<typeof vi.fn> },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../shell/current-editor-context', () => ({ useCurrentNoteEditor: () => ({ editor: mocks.editor, editorNoteId: 'note' }) }));
vi.mock('@prismical/app-client', () => ({
  useNoteCreatedNotice: (select: (state: { notice: typeof mocks.notice }) => unknown) => select({ notice: mocks.notice }),
  useSessionView: () => ({ activeSessionKey: 'owner' }),
  activeOrgIdOf: () => 'org',
}));
const { SkillNoteCreated } = await import('./skill-note-created');
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.notice = null; });

it('keeps actual Undo on the successful notice and switches to neutral retry when undo needs saving', () => {
  mocks.notice = { noteId: 'note', ownerKey: 'owner', orgId: 'org', undo: mocks.undo };
  const view = render(<SkillNoteCreated noteId="note" />);
  expect(screen.getByRole('status').className).toContain('text-success');
  expect(screen.getByText('skills.diff.noteCreated')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'skills.diff.undo' }));
  expect(mocks.undo).toHaveBeenCalledWith(mocks.editor);
  act(() => { mocks.notice = { ...mocks.notice!, undoPending: true }; });
  view.rerender(<SkillNoteCreated noteId="note" />);
  expect(screen.getByRole('status').className).not.toContain('text-success');
  expect(screen.queryByText('skills.diff.noteCreated')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.retry' }));
  expect(mocks.undo).toHaveBeenCalledTimes(2);
});

it('does not show a success notice for a different note or owner', () => {
  mocks.notice = { noteId: 'other-note', ownerKey: 'owner', orgId: 'org', undo: mocks.undo };
  const view = render(<SkillNoteCreated noteId="note" />);
  expect(screen.queryByRole('status')).toBeNull();
  mocks.notice = { ...mocks.notice, noteId: 'note', ownerKey: 'other-owner' };
  view.rerender(<SkillNoteCreated noteId="note" />);
  expect(screen.queryByRole('status')).toBeNull();
});
