// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { useSkillRunActivityStore } from '../../../app-client/src/notes/skill-run-activity-store';
vi.mock('@prismical/app-client', async () => {
  const actual = await import('../../../app-client/src/notes/skill-run-activity-store');
  return { useSkillRuns: actual.useSkillRuns };
});
import { RecordingSkillStatus } from './recording-skill-status';

const i18n = createApplicationI18nSync();
const review = vi.fn();
const panel = (noteId = 'note_1') => (
  <I18nextProvider i18n={i18n}>
    <RecordingSkillStatus noteId={noteId} onReviewInNote={review} />
  </I18nextProvider>
);
const begin = (skillName = 'Enhance', cancel = vi.fn()) =>
  useSkillRunActivityStore
    .getState()
    .begin({ noteId: 'note_1', skillId: 'skill_1', skillName, source: 'auto-enhance', cancel });
beforeEach(() => {
  useSkillRunActivityStore.setState({ runsByNote: new Map(), runningByNote: new Map() });
  review.mockClear();
});
afterEach(cleanup);

describe('recording panel skill status', () => {
  it('keeps the enhancement spinner through the pending-to-running handoff', () => {
    const old = begin();
    useSkillRunActivityStore.getState().finish(old, 'staged');
    const view = render(<I18nextProvider i18n={i18n}>
      <RecordingSkillStatus noteId="note_1" onReviewInNote={review} pending hideCompleted />
    </I18nextProvider>);
    const status = screen.getByRole('status', { name: 'Running Enhance…' });
    expect(screen.queryByRole('button')).toBeNull();
    const cancel = vi.fn();
    act(() => { begin('Enhance', cancel); });
    view.rerender(panel());
    expect(screen.getByRole('status', { name: 'Running Enhance…' })).toBe(status);
    fireEvent.click(screen.getByRole('button', { name: 'Stop Enhance' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('shows the readiness wait and stops the existing run through its abort handle', () => {
    const cancel = vi.fn(() => useSkillRunActivityStore.getState().finish(id, 'stopped'));
    const id = begin('Enhance', cancel);
    render(panel());
    expect(screen.getByRole('status', { name: 'Running Enhance…' })).toBeTruthy();
    act(() => useSkillRunActivityStore.getState().setPhase(id, 'waiting-transcript'));
    expect(
      screen.getByRole('status', { name: 'Enhance · Waiting for transcription to finish…' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Enhance' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop Enhance' })).toBeNull();
  });
  it('keeps an unreviewed result on its note and reveals the existing review UI', () => {
    const id = begin();
    useSkillRunActivityStore.getState().finish(id, 'staged');
    const view = render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Review in note' }));
    expect(review).toHaveBeenCalledOnce();
    view.rerender(panel('note_2'));
    expect(screen.queryByText('Enhance drafted a suggestion')).toBeNull();
    expect(useSkillRunActivityStore.getState().runsByNote.get('note_1')?.[0]?.status).toBe(
      'staged'
    );
  });
  it('uses the actual custom skill name and retains actionable failures', () => {
    const id = begin('Meeting recap');
    render(panel());
    expect(screen.getByRole('status', { name: 'Running Meeting recap…' })).toBeTruthy();
    const retry = vi.fn();
    act(() =>
      useSkillRunActivityStore.getState().finish(id, 'error', 'Provider unavailable', {
        actions: [{ kind: 'retry', label: 'Retry', onClick: retry }],
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

it('removes a skipped run from the recording footer', () => {
  const id = begin();
  useSkillRunActivityStore.getState().finish(id, 'skipped', 'No transcript');
  render(panel());
  expect(screen.queryByRole('status')).toBeNull();
});
it('hides old results while finishing but retains an active Stop action', () => {
  const id = begin();
  useSkillRunActivityStore.getState().finish(id, 'applied');
  render(<I18nextProvider i18n={i18n}>
    <RecordingSkillStatus noteId="note_1" onReviewInNote={review} hideCompleted />
  </I18nextProvider>);
  expect(screen.queryByRole('status')).toBeNull();
  act(() => { begin(); });
  expect(screen.getByRole('button', { name: 'Stop Enhance' })).toBeTruthy();
});

it.each(['kept', 'undone', 'superseded'] as const)(
  'clears %s results from the footer without removing their history',
  status => {
    const id = begin();
    useSkillRunActivityStore.getState().finish(id, 'staged');
    render(panel());
    expect(screen.getByRole('button', { name: 'Review in note' })).toBeTruthy();
    act(() => useSkillRunActivityStore.getState().resolveStaged('note_1', status));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review in note' })).toBeNull();
    expect(useSkillRunActivityStore.getState().runsByNote.get('note_1')?.at(-1)?.status).toBe(status);
  }
);
