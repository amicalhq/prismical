// @vitest-environment jsdom
import * as React from 'react';
import * as Y from 'yjs';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { buildWebEditorExtensions } from '../../../app-client/src/notes/editor-extensions';
import { startLoadingTiming } from '../../../app-client/src/loading-timing';
import { CurrentEditorProvider, useCurrentNoteEditor } from '../shell/current-editor-context';

const collab = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@prismical/app-client', () => ({
  useNoteCollab: () => collab.current,
  buildWebEditorExtensions: (...args: Parameters<typeof buildWebEditorExtensions>) =>
    buildWebEditorExtensions(...args),
  startLoadingTiming: (...args: Parameters<typeof startLoadingTiming>) =>
    startLoadingTiming(...args),
  useSkillDiffDecorations: () => {},
}));
vi.mock('./inline-skill-popover', () => ({ InlineSkillPopover: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { NoteBodyEditor } = await import('./note-body-editor');

const diagnosticWindow = window as Window & { __PRISMICAL_LOADING_PHASES__?: boolean };
const events: Array<Record<string, unknown>> = [];
window.addEventListener('prismical:loading-phase', event =>
  events.push((event as CustomEvent).detail)
);
const documents: Y.Doc[] = [];
// jsdom has no layout hit-testing; the real placeholder plugin treats a null hit
// as outside the viewport. Editor/schema/collaboration behavior stays real.
Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
afterEach(() => {
  cleanup();
  documents.splice(0).forEach(doc => doc.destroy());
  events.length = 0;
  delete diagnosticWindow.__PRISMICAL_LOADING_PHASES__;
});
function PublishedEditor() {
  const { editor } = useCurrentNoteEditor();
  return <output data-testid="published">{editor ? 'published' : 'unavailable'}</output>;
}
function fixture(writable = true) {
  return (
    <CurrentEditorProvider>
      <NoteBodyEditor noteId="nt_abcdefghijklmnop" writable={writable} />
      <PublishedEditor />
    </CurrentEditorProvider>
  );
}

it.each([false, true])(
  'keeps the real editor unpublished/uneditable before sync with recorder=%s',
  async enabled => {
    diagnosticWindow.__PRISMICAL_LOADING_PHASES__ = enabled;
    const doc = new Y.Doc();
    documents.push(doc);
    collab.current = {
      doc,
      status: 'connected',
      synced: false,
      scope: 'read-write',
      error: null,
      loadingAttemptId: 'parent-attempt',
    };
    const view = render(fixture());
    await act(async () => {});
    expect(view.getByTestId('published').textContent).toBe('unavailable');
    expect(view.container.querySelector('.ProseMirror[contenteditable="true"]')).toBeNull();
    expect(events.some(event => event.phase === 'editor_editable')).toBe(false);
    collab.current = { ...collab.current, synced: true };
    view.rerender(fixture());
    await waitFor(() =>
      expect(view.container.querySelector('.ProseMirror[contenteditable="true"]')).not.toBeNull()
    );
    expect(view.getByTestId('published').textContent).toBe('published');
    expect(events.some(event => event.phase === 'editor_editable')).toBe(enabled);
    expect(
      events
        .filter(event => event.kind === 'note_editor')
        .every(event => event.parentAttemptId === 'parent-attempt')
    ).toBe(true);
  }
);

it('keeps server-readonly content uneditable with diagnostics enabled', async () => {
  diagnosticWindow.__PRISMICAL_LOADING_PHASES__ = true;
  const doc = new Y.Doc();
  documents.push(doc);
  collab.current = { doc, status: 'connected', synced: true, scope: 'readonly', error: null };
  const view = render(fixture());
  await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull());
  expect(view.container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe(
    'false'
  );
  expect(events.some(event => event.phase === 'editor_editable')).toBe(false);
});
