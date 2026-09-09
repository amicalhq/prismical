// @vitest-environment jsdom
import * as React from 'react';
import type { Editor } from '@tiptap/react';
import type { NoteCollab } from '@prismical/app-client';
import type { SkillDiffDockBar } from './skill-diff-dock-bar';
import * as Y from 'yjs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  collab: {} as NoteCollab,
  editor: { isDestroyed: false },
  bar: {} as React.ComponentProps<typeof SkillDiffDockBar>,
  note: { writable: true },
}));
vi.mock('@prismical/app-client', () => ({
  useNoteCollab: () => harness.collab,
  useNote: () => ({ data: harness.note }),
  useSkillDiffStore: (select: (state: { candidatesByNote: Map<string, { skillName: string }> }) => unknown) => select({ candidatesByNote: new Map([['original', { skillName: 'Cleanup' }]]) }),
  buildWebEditorExtensions: () => [],
}));
vi.mock('@tiptap/react', () => ({
  useEditor: () => harness.editor,
  EditorContent: () => null,
}));
vi.mock('./skill-diff-dock-bar', () => ({
  SkillDiffDockBar: (props: React.ComponentProps<typeof SkillDiffDockBar>) => { harness.bar = props; return <div>Ready review</div>; },
  SkillDiffPendingBar: () => <div>Waiting for original note</div>,
}));
const { SkillProposalHost } = await import('./skill-proposal-host');
let target: Y.Doc;
let source: Y.Doc;
beforeEach(() => {
  target = new Y.Doc();
  source = new Y.Doc();
  harness.note = { writable: true };
  harness.collab = {
    doc: target, synced: false, scope: 'read-write', error: null,
    hasWriteAccess: vi.fn(() => true), waitForPendingChanges: vi.fn(async () => {}),
  } as unknown as NoteCollab;
});
afterEach(() => { cleanup(); source.destroy(); target.destroy(); });

function mount() {
  const onEditor = vi.fn();
  const sourceEditor = { extensionManager: { extensions: [{ name: 'collaboration', options: { document: source } }] } } as unknown as Editor;
  const props = { hostKey: 'owner:original', noteId: 'original', compact: false, onEditor, sourceEditor };
  const view = render(<SkillProposalHost {...props} />);
  return { ...view, onEditor, props };
}

describe('original-note proposal host', () => {
  it('waits for original sync, retains its editor after navigation, and requires live write access', async () => {
    const { onEditor, rerender, props } = mount();
    expect(screen.getByText('Waiting for original note')).toBeTruthy();
    expect(onEditor).not.toHaveBeenCalledWith('owner:original', harness.editor);
    harness.collab.synced = true;
    rerender(<SkillProposalHost {...props} />);
    expect(onEditor).toHaveBeenLastCalledWith('owner:original', harness.editor);
    expect(harness.bar.editor).toBe(harness.editor);
    // Leaving the visible original editor removes only that input source.
    rerender(<SkillProposalHost {...props} sourceEditor={null} />);
    expect(screen.getByText('Ready review')).toBeTruthy();
    expect(harness.bar.noteId).toBe('original');
    await harness.bar.beforeApplyComplete!();
    expect(harness.collab.waitForPendingChanges).toHaveBeenCalledTimes(1);
    vi.mocked(harness.collab.hasWriteAccess).mockReturnValue(false);
    expect(harness.bar.canApply!()).toBe(false);
    await expect(harness.bar.beforeApplyComplete!()).rejects.toThrow('not writable');
    expect(harness.collab.waitForPendingChanges).toHaveBeenCalledTimes(1);
  });

  it('does not expose an editor when the original note is read-only', () => {
    harness.collab.synced = true;
    harness.note.writable = false;
    const { onEditor } = mount();
    expect(screen.getByText('Waiting for original note')).toBeTruthy();
    expect(onEditor).not.toHaveBeenCalledWith('owner:original', harness.editor);
  });

  it('includes unsent source edits and disconnects that source after navigation', () => {
    source.getText('body').insert(0, 'Unsent');
    const { rerender, props } = mount();
    expect(target.getText('body').toString()).toBe('Unsent');
    act(() => source.getText('body').insert(6, ' typing'));
    expect(target.getText('body').toString()).toBe('Unsent typing');
    rerender(<SkillProposalHost {...props} sourceEditor={null} />);
    source.getText('body').insert(13, ' later');
    expect(target.getText('body').toString()).toBe('Unsent typing');
  });
});
