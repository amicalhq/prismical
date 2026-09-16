// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Toaster, toast } from 'sonner';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../shell/current-editor-context', () => ({
  useCurrentNoteEditor: () => ({ editor: null, editorNoteId: 'note' }),
}));
vi.mock('@prismical/app-client', async () => ({
  useNoteCreatedNotice: (await import('../../../app-client/src/notes/note-created-notice')).useNoteCreatedNotice,
  useSessionView: () => ({ activeSessionKey: 'owner' }),
  activeOrgIdOf: () => 'org',
}));
const { useNoteCreatedNotice } = await import('../../../app-client/src/notes/note-created-notice');
const { SkillNoteCreated } = await import('./skill-note-created');

afterEach(() => {
  cleanup();
  toast.dismiss();
  useNoteCreatedNotice.setState({ notice: null });
});

it('does not bring back an in-flight Undo toast after navigation with the real Sonner host', async () => {
  useNoteCreatedNotice.setState({ notice: {
    noteId: 'note', artifactId: 'recovery', ownerKey: 'owner', orgId: 'org',
    undoing: true, undoPending: true, message: 'Undoing',
  } });
  const content = (noteId: string) => <><Toaster theme="light" /><SkillNoteCreated noteId={noteId} /></>;
  const view = render(content('note'));
  await screen.findByText('Undoing');
  view.rerender(content('other-note'));
  view.rerender(content('note'));
  // Completion callbacks only update an existing notice, so leaving cannot
  // resurrect a toast when the in-flight operation later fails.
  act(() => useNoteCreatedNotice.setState(s => ({ notice: s.notice
    ? { ...s.notice, undoing: false, error: true, message: 'Undo sync failed' } : null })));
  await waitFor(() => expect(screen.queryByText('Undoing')).toBeNull(), { timeout: 2000 });
  expect(useNoteCreatedNotice.getState().notice).toBeNull();
  expect(screen.queryByText('Undo sync failed')).toBeNull();
});
