// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import type { Editor } from '@tiptap/react';
import { useSkillDiffStore } from '../../../app-client/src/notes/diff/skill-diff-store';
import { WalkthroughContext } from './context';
import { TooltipProvider } from '../ui/tooltip';
const m = vi.hoisted(() => ({
  accept: vi.fn(),
  apply: vi.fn(),
  notify: vi.fn(),
  mode: 'append-section',
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@prismical/app-client', async () => {
  const { ApiError } = await import('../../../app-client/src/api/client');
  const { useSkillDiffStore } = await import('../../../app-client/src/notes/diff/skill-diff-store');
  return {
    ApiError,
    useSkillDiffStore,
    useAcceptArtifact: () => ({ mutateAsync: m.accept }),
    useRunSkill: () => ({ run: vi.fn(), cancel: vi.fn(), running: false }),
    useSkillRunActivityStore: { getState: () => ({ resolveStaged: vi.fn() }) },
    clearDiffDecorations: vi.fn(),
    resolveVerifiedRange: vi.fn(),
    restoreLastSkillRun: vi.fn().mockResolvedValue(undefined),
    useAutoEnhanceStore: { getState: () => ({ markFailed: vi.fn() }) },
    enhancedRecordingsKey: () => [],
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { SkillDiffDockBar } = await import('../components/skill-diff-dock-bar');
function mount() {
  useSkillDiffStore.getState().stage({
    noteId: 'note',
    mode: m.mode as 'append-section' | 'replace-doc',
    recordingId: 'recording',
    skillId: 'enhance',
    skillName: 'Enhance',
    modelId: 'model',
    rawMarkdown: 'Output',
    content: [],
    reasoning: null,
    refineInstruction: null,
    selectionText: null,
  });
  const editor = {
    getJSON: () => ({}),
    commands: { insertArtifactBlock: m.apply, setContent: m.apply },
    isDestroyed: false,
    view: { dom: document.createElement('div') },
  } as unknown as Editor;
  render(
    <I18nextProvider i18n={createApplicationI18nSync()}>
      <TooltipProvider>
        <WalkthroughContext.Provider value={m.notify}>
          <SkillDiffDockBar editor={editor} noteId="note" />
        </WalkthroughContext.Provider>
      </TooltipProvider>
    </I18nextProvider>
  );
}
beforeEach(() => {
  m.mode = 'append-section';
  m.accept.mockReset().mockResolvedValue({ artifactId: 'artifact', version: 1, generatedAt: '' });
  m.apply.mockReset().mockReturnValue(true);
  m.notify.mockReset();
});
afterEach(cleanup);
it('signals only after persisted acceptance and successful editor application', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  await waitFor(() =>
    expect(m.notify).toHaveBeenCalledWith({
      type: 'kept',
      noteId: 'note',
      recordingId: 'recording',
    })
  );
  expect(m.accept).toHaveBeenCalledTimes(1);
  expect(m.apply).toHaveBeenCalledTimes(1);
});
it('does not complete when persistence fails', async () => {
  m.accept.mockRejectedValue(new Error('offline'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  await waitFor(() => expect(m.accept).toHaveBeenCalledTimes(1));
  expect(m.apply).not.toHaveBeenCalled();
  expect(m.notify).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error', code: 'accept_failed' })
  );
  expect(m.notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kept' }));
});
it('does not complete when the editor rejects the change', async () => {
  m.apply.mockReturnValue(false);
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  await waitFor(() => expect(m.apply).toHaveBeenCalledTimes(1));
  expect(m.notify).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error', code: 'accept_failed' })
  );
  expect(m.notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kept' }));
});
it('does not complete when replacing the document throws', async () => {
  m.mode = 'replace-doc';
  m.apply.mockImplementation(() => {
    throw new Error('invalid content');
  });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  await waitFor(() => expect(m.apply).toHaveBeenCalledTimes(1));
  expect(m.notify).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error', code: 'accept_failed' })
  );
  expect(m.notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kept' }));
});
