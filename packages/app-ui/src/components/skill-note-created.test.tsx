// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  undo: vi.fn(),
  show: vi.fn(), dismiss: vi.fn(),
  editor: { id: 'current-editor' } as { id: string } | null,
}));
vi.mock('sonner', () => ({ toast: Object.assign(mocks.show, { success: mocks.show, error: mocks.show, loading: mocks.show, dismiss: mocks.dismiss }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../shell/current-editor-context', () => ({
  useCurrentNoteEditor: () => ({ editor: mocks.editor, editorNoteId: 'note' }),
}));
vi.mock('@prismical/app-client', async () => ({
  useNoteCreatedNotice: (await import('../../../app-client/src/notes/note-created-notice'))
    .useNoteCreatedNotice,
  useSessionView: () => ({ activeSessionKey: 'owner' }),
  activeOrgIdOf: () => 'org',
}));
const { useNoteCreatedNotice } = await import('../../../app-client/src/notes/note-created-notice');
const setNotice = (patch = {}) =>
  useNoteCreatedNotice.setState({
    notice: {
      noteId: 'note',
      artifactId: 'artifact',
      ownerKey: 'owner',
      orgId: 'org',
      undo: mocks.undo,
      ...patch,
    },
  });
const { SkillNoteCreated } = await import('./skill-note-created');
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.dismiss.mockReset();
  useNoteCreatedNotice.setState({ notice: null });
  mocks.editor = { id: 'current-editor' };
  vi.useRealTimers();
});

const latest = () => mocks.show.mock.calls.at(-1)!;

it('uses the shared toaster with a separate Undo action', () => {
  setNotice();
  render(<SkillNoteCreated noteId="note" />);
  expect(latest()[0]).toBe('skills.diff.noteCreated');
  expect(latest()[1]).toMatchObject({ id: expect.stringMatching(/^note-edit-artifact-/), duration: Infinity, closeButton: true });
  expect(latest()[1].action.label).toBe('skills.diff.undo');
  const preventDefault = vi.fn();
  latest()[1].action.onClick({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  expect(mocks.undo).toHaveBeenCalledWith(mocks.editor);
});

it('does not show a notice for another note or owner', () => {
  setNotice({ noteId: 'other-note' });
  const view = render(<SkillNoteCreated noteId="note" />);
  expect(mocks.show).not.toHaveBeenCalled();
  act(() => setNotice({ ownerKey: 'other-owner' }));
  view.rerender(<SkillNoteCreated noteId="note" />);
  expect(mocks.show).not.toHaveBeenCalled();
});

it('clears the store on dismissal and stays dismissed after remount', () => {
  setNotice();
  const view = render(<SkillNoteCreated noteId="note" />);
  act(() => latest()[1].onDismiss());
  expect(useNoteCreatedNotice.getState().notice).toBeNull();
  expect(mocks.dismiss).toHaveBeenCalledWith(expect.stringMatching(/^note-edit-artifact-/));
  expect(mocks.undo).not.toHaveBeenCalled();
  mocks.show.mockClear();
  view.unmount();
  render(<SkillNoteCreated noteId="note" />);
  expect(mocks.show).not.toHaveBeenCalled();
});

it('disables Undo while the editor is unavailable', () => {
  setNotice();
  mocks.editor = null;
  render(<SkillNoteCreated noteId="note" />);
  expect(latest()[1].action).toBeUndefined();
});

it('updates one toast through Undo progress and persistent retry', () => {
  vi.useFakeTimers();
  setNotice();
  render(<SkillNoteCreated noteId="note" />);
  act(() => setNotice({ undoing: true, message: 'Undoing…' }));
  expect(latest()[1]).toMatchObject({ id: expect.stringMatching(/^note-edit-artifact-/), closeButton: false, dismissible: false });
  expect(latest()[1].action).toBeUndefined();
  expect(mocks.dismiss).not.toHaveBeenCalled();
  act(() => setNotice({ error: true, undoPending: true, message: 'Could not save Undo', description: 'Restored on this device.' }));
  act(() => vi.advanceTimersByTime(60_000));
  expect(useNoteCreatedNotice.getState().notice?.error).toBe(true);
  expect(latest()[0]).toBe('Could not save Undo');
  expect(latest()[1].description).toBe('Restored on this device.');
  expect(latest()[1].action.label).toBe('common.actions.retry');
  latest()[1].action.onClick({ preventDefault: vi.fn() });
  expect(mocks.undo).toHaveBeenCalledWith(mocks.editor);
});

it('keeps in-flight Undo visible when the workflow is busy', () => {
  setNotice({ undoing: true, message: 'Undoing…' });
  render(<SkillNoteCreated noteId="note" active={false} />);
  expect(latest()[0]).toBe('Undoing…');
});

it('discards an unexpired toast on navigation and does not show it on return', () => {
  setNotice();
  const view = render(<SkillNoteCreated noteId="note" />);
  view.rerender(<SkillNoteCreated noteId="other-note" />);
  expect(useNoteCreatedNotice.getState().notice).toBeNull();
  mocks.show.mockClear();
  view.rerender(<SkillNoteCreated noteId="note" />);
  expect(mocks.show).not.toHaveBeenCalled();
});

it('does not let an old toast dismiss a newer notice', () => {
  setNotice();
  render(<SkillNoteCreated noteId="note" />);
  const dismissOld = latest()[1].onDismiss;
  act(() => setNotice({ artifactId: 'next' }));
  act(() => dismissOld());
  expect(useNoteCreatedNotice.getState().notice?.artifactId).toBe('next');
});

it('gives a new notice its own deadline', () => {
  vi.useFakeTimers();
  setNotice();
  act(() => vi.advanceTimersByTime(6_000));
  setNotice({ artifactId: 'next' });
  act(() => vi.advanceTimersByTime(4_000));
  expect(useNoteCreatedNotice.getState().notice?.artifactId).toBe('next');
  act(() => vi.advanceTimersByTime(6_000));
  expect(useNoteCreatedNotice.getState().notice).toBeNull();
});

it('does not revive pending recovery after leaving the note', () => {
  setNotice({ undoPending: true, error: true });
  const view = render(<SkillNoteCreated noteId="note" />);
  const previous = latest()[1];
  mocks.dismiss.mockImplementation(() => previous.onDismiss());
  view.rerender(<SkillNoteCreated noteId="other-note" />);
  expect(useNoteCreatedNotice.getState().notice).toBeNull();
  mocks.show.mockClear();
  view.rerender(<SkillNoteCreated noteId="note" />);
  expect(mocks.show).not.toHaveBeenCalled();
});

it('clears the notice when the note surface unmounts', async () => {
  setNotice();
  const view = render(<SkillNoteCreated noteId="note" />);
  view.unmount();
  await act(async () => {});
  expect(useNoteCreatedNotice.getState().notice).toBeNull();
});

it('does not treat StrictMode effect replay as navigation', async () => {
  setNotice();
  render(<React.StrictMode><SkillNoteCreated noteId="note" /></React.StrictMode>);
  await act(async () => {});
  expect(useNoteCreatedNotice.getState().notice).not.toBeNull();
});
