// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { I18nextProvider } from 'react-i18next';

const mocks = vi.hoisted(() => ({
  onSend: vi.fn(),
  onRunSkill: vi.fn(),
  askAi: true,
  notes: [{ id: 'note_b', title: 'Birch plan' }],
}));
vi.mock('@prismical/app-client', () => ({
  useNotes: () => ({ data: mocks.notes }),
  useSkillsList: () => ({
    data: [
      {
        id: 'skl_cleanup',
        name: 'Cleanup',
        enabled: true,
        config: { outputTarget: 'note-body', surface: ['dock'] },
      },
    ],
  }),
  useEntitlements: () => ({ entitlements: { features: { askAi: mocks.askAi } }, isResolved: true }),
  useNavigation: () => ({ push: vi.fn() }),
  usePorts: () => ({
    navigation: {
      Link: React.forwardRef<HTMLAnchorElement, React.ComponentProps<'a'>>(function Link(p, ref) {
        return <a ref={ref} {...p} />;
      }),
    },
  }),
  findOption: () => null,
  PRISMICAL_CLOUD_INSTANCE_ID: 'prismical-cloud',
}));
const { AskComposer } = await import('./ask-composer');
const { useAskNoteContext } = await import('./use-ask-note-context');
const i18n = createApplicationI18nSync('en');

function composer(props: { withSkills?: boolean; canSubmit?: () => boolean } = {}) {
  const ref = React.createRef<import('./ask-composer').AskComposerHandle>();
  const ui = (
    <I18nextProvider i18n={i18n}>
      <AskComposer
        ref={ref}
        busy={false}
        canSubmit={props.canSubmit}
        onSend={mocks.onSend}
        onRunSkill={props.withSkills === false ? undefined : mocks.onRunSkill}
        onStop={() => {}}
        modelGroups={[]}
        modelValue={{ instanceId: 'prismical-cloud', modelId: 'auto' }}
        onModelChange={() => {}}
      />
    </I18nextProvider>
  );
  return { ui, ref };
}

const draft = () => screen.getByRole('textbox');
const typeAndEnter = (text: string) => {
  draft().textContent = text;
  fireEvent.input(draft());
  fireEvent.keyDown(draft(), { key: 'Enter' });
};

const appendDraft = (text: string) => {
  draft().appendChild(document.createTextNode(text));
  fireEvent.input(draft());
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.askAi = true;
  mocks.notes = [{ id: 'note_b', title: 'Birch plan' }];
});

function WithContext({
  currentNote = { id: 'note_a', title: 'Cedar plan' },
}: {
  currentNote?: { id: string; title: string } | null;
}) {
  const context = useAskNoteContext(currentNote, 'account:organization');
  return (
    <I18nextProvider i18n={i18n}>
      <AskComposer
        busy={false}
        onRunSkill={mocks.onRunSkill}
        currentNote={currentNote}
        focusNote={context.focusNote}
        onRemoveCurrentNote={context.remove}
        onRestoreCurrentNote={context.restore}
        onSend={(text, notes) => mocks.onSend(text, context.resolveNotes(notes))}
        onStop={() => {}}
        modelGroups={[]}
        modelValue={{ instanceId: 'prismical-cloud', modelId: 'auto' }}
        onModelChange={() => {}}
      />
    </I18nextProvider>
  );
}

describe('AskComposer', () => {
  it('finds an older note beyond the recent twelve and attaches it with the keyboard', () => {
    mocks.notes = [
      { id: 'note_old', title: 'Archived Cedar research' },
      ...Array.from({ length: 15 }, (_, i) => ({ id: `note_${i}`, title: `Recent plan ${i}` })),
    ];
    render(composer().ui);
    appendDraft('Compare with @CEDAR');
    expect(screen.getByRole('button', { name: 'Archived Cedar research' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Recent plan 14' })).toBeNull();
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).not.toHaveBeenCalled();
    expect(draft().textContent).not.toContain('@CEDAR');
    expect(draft().querySelectorAll('.tok-note')).toHaveLength(1);
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).toHaveBeenCalledWith('Compare with Archived Cedar research', [
      { id: 'note_old', title: 'Archived Cedar research' },
    ]);
  });

  it('keeps empty and matching mention results bounded and newest first', () => {
    mocks.notes = Array.from({ length: 15 }, (_, i) => ({
      id: `note_${i}`,
      title: `Research plan ${i}`,
    }));
    render(composer().ui);
    appendDraft('@');
    expect(
      screen.getAllByRole('button', { name: /^Research plan/ }).map(b => b.textContent)
    ).toEqual([14, 13, 12, 11, 10, 9].map(i => `Research plan ${i}`));
    appendDraft('research');
    expect(
      screen.getAllByRole('button', { name: /^Research plan/ }).map(b => b.textContent)
    ).toEqual([14, 13, 12, 11, 10, 9].map(i => `Research plan ${i}`));
  });

  it('shows removable automatic context without changing the draft, and can restore it', () => {
    render(<WithContext />);
    appendDraft('What changed?');
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).toHaveBeenLastCalledWith('What changed?', [
      { id: 'note_a', title: 'Cedar plan' },
    ]);
    expect(draft().querySelectorAll('.tok-note')).toHaveLength(1);
    appendDraft('Keep this draft');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cedar plan' }));
    expect(draft().textContent?.trim()).toBe('Keep this draft');
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).toHaveBeenLastCalledWith('Keep this draft', []);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.click(screen.getByRole('button', { name: 'This note: Cedar plan' }));
    appendDraft('Summarize this note');
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).toHaveBeenLastCalledWith('Summarize this note', [
      { id: 'note_a', title: 'Cedar plan' },
    ]);
  });

  it('does not send a question when only automatic context is present', () => {
    render(<WithContext />);
    expect(draft().querySelector('.tok-note')?.textContent).toContain('@Cedar plan');
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).not.toHaveBeenCalled();
  });

  it('keeps draft and selected notes through background navigation and renaming', () => {
    const { rerender } = render(<WithContext />);
    appendDraft('Compare with ');
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.click(screen.getByRole('button', { name: 'Birch plan' }));
    rerender(<WithContext currentNote={{ id: 'note_c', title: 'Maple plan' }} />);
    expect(draft().querySelectorAll('.tok-note')).toHaveLength(2);
    expect(draft().textContent).toContain('Compare with ');
    expect(draft().textContent).not.toContain('Cedar');
    rerender(<WithContext currentNote={{ id: 'note_c', title: 'Maple revised' }} />);
    expect(draft().textContent).toContain('@Maple revised');
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).toHaveBeenLastCalledWith('Compare with Birch plan', [
      { id: 'note_c', title: 'Maple revised' },
      { id: 'note_b', title: 'Birch plan' },
    ]);
    rerender(<WithContext currentNote={null} />);
    expect(draft().querySelector('.tok-note')).toBeNull();
  });

  it('honors keyboard removal and select-all replacement of automatic context', () => {
    render(<WithContext />);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(draft(), 1);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.keyDown(draft(), { key: 'Backspace' });
    expect(draft().querySelector('.tok-note')).toBeNull();
    typeAndEnter('Workspace question');
    expect(mocks.onSend).toHaveBeenLastCalledWith('Workspace question', []);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.click(screen.getByRole('button', { name: 'This note: Cedar plan' }));
    typeAndEnter('Replace entire draft');
    expect(mocks.onSend).toHaveBeenLastCalledWith('Replace entire draft', []);
  });

  it('does not submit while activating a token removal button with the keyboard', () => {
    render(<WithContext />);
    appendDraft('Keep this draft');
    const remove = screen.getByRole('button', { name: 'Remove Cedar plan' });
    fireEvent.keyDown(remove, { key: 'Enter' });
    expect(mocks.onSend).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(draft().textContent?.trim()).toBe('Keep this draft');
  });

  it('uses the same presentation for explicit tokens and removes them without changing automatic context', () => {
    render(<WithContext />);
    const autoClass = draft().querySelector('.tok-note')!.className;
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.click(screen.getByRole('button', { name: 'Birch plan' }));
    expect(draft().querySelector('.tok-note:not([data-auto-context])')!.className).toBe(autoClass);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.click(screen.getByRole('button', { name: 'Birch plan' }));
    expect(draft().querySelectorAll('.tok-note')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Birch plan' }));
    appendDraft('Only this note');
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).toHaveBeenLastCalledWith('Only this note', [
      { id: 'note_a', title: 'Cedar plan' },
    ]);
  });

  it('keeps slash commands working with automatic context without adding the note title to instructions', () => {
    render(<WithContext />);
    appendDraft('/Clean');
    expect(screen.getByRole('button', { name: /Cleanup/ })).toBeTruthy();
    fireEvent.keyDown(draft(), { key: 'Enter' });
    appendDraft('keep headings');
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onRunSkill).toHaveBeenLastCalledWith(
      { id: 'skl_cleanup', name: 'Cleanup' },
      'keep headings'
    );
    expect(draft().querySelectorAll('.tok-note')).toHaveLength(1);
  });

  it('keeps the context menu open after focus moves from the draft to the plus button', () => {
    vi.useFakeTimers();
    try {
      render(composer().ui);
      const plus = screen.getByRole('button', { name: 'Add context' });
      fireEvent.focus(draft());
      fireEvent.blur(draft(), { relatedTarget: plus });
      fireEvent.click(plus);
      act(() => vi.advanceTimersByTime(500));
      expect(plus.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('button', { name: 'Birch plan' })).toBeTruthy();
      expect(screen.queryByText('MCP tools — coming soon')).toBeNull();
      fireEvent.click(plus);
      expect(plus.getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses context on outside clicks, Escape, or focus leaving the composer', () => {
    render(composer().ui);
    const plus = screen.getByRole('button', { name: 'Add context' });
    fireEvent.click(plus);
    fireEvent.pointerDown(draft());
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(plus.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(plus);
    fireEvent.keyDown(plus, { key: 'Escape' });
    expect(plus.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(plus);
    fireEvent.click(plus);
    fireEvent.blur(plus, { relatedTarget: screen.getByRole('button', { name: 'Birch plan' }) });
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    fireEvent.blur(plus, { relatedTarget: document.body });
    expect(plus.getAttribute('aria-expanded')).toBe('false');
  });

  it('preserves the draft when review admission changes before Enter', () => {
    let admitted = true;
    render(composer({ canSubmit: () => admitted }).ui);
    draft().textContent = 'Keep my question';
    fireEvent.input(draft());
    admitted = false;
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).not.toHaveBeenCalled();
    expect(draft().textContent).toBe('Keep my question');
    admitted = true;
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onSend).toHaveBeenCalledWith('Keep my question', []);
  });

  it('sends free text when Ask is in the plan, with no gate line', () => {
    render(composer().ui);
    expect(screen.queryByRole('status')).toBeNull();
    typeAndEnter('What changed?');
    expect(mocks.onSend).toHaveBeenCalledWith('What changed?', []);
  });

  it('on a plan without Ask: a persistent gate line with the plans link, and the skill placeholder', () => {
    mocks.askAi = false;
    render(composer().ui);
    expect(screen.getByRole('status').textContent).toContain(
      'Ask AI isn’t included in your plan. Skills still run here.'
    );
    expect(screen.getByRole('link', { name: 'See plans' }).getAttribute('href')).toBe(
      '/settings/billing'
    );
    expect(draft().getAttribute('data-placeholder')).toBe('Type / to run a skill');
  });

  it('refuses free text, keeps the draft, and swaps the line to the refusal copy for a while', () => {
    vi.useFakeTimers();
    try {
      mocks.askAi = false;
      render(composer().ui);
      typeAndEnter('What changed?');
      expect(mocks.onSend).not.toHaveBeenCalled();
      expect(draft().textContent).toBe('What changed?');
      expect(screen.getByRole('status').textContent).toContain('Type / to run a skill instead.');
      // A second refusal restarts the clock: still showing 7 s after the first one.
      act(() => vi.advanceTimersByTime(7000));
      fireEvent.keyDown(draft(), { key: 'Enter' });
      act(() => vi.advanceTimersByTime(7000));
      expect(screen.getByRole('status').textContent).toContain('Type / to run a skill instead.');
      act(() => vi.advanceTimersByTime(1500));
      expect(screen.getByRole('status').textContent).toContain('Skills still run here.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still runs a /skill on a plan without Ask', () => {
    mocks.askAi = false;
    const { ui, ref } = composer();
    render(ui);
    ref.current!.insertSkill({ id: 'skl_cleanup', name: 'Cleanup' });
    draft().appendChild(document.createTextNode('keep the headings'));
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(mocks.onRunSkill).toHaveBeenCalledWith(
      { id: 'skl_cleanup', name: 'Cleanup' },
      'keep the headings'
    );
    expect(screen.getByRole('status').textContent).toContain('Skills still run here.');
  });

  it('off a note there is no skill lane: the line and the placeholder just say Ask is not in the plan', () => {
    mocks.askAi = false;
    render(composer({ withSkills: false }).ui);
    expect(draft().getAttribute('data-placeholder')).toBe('Ask AI isn’t in your plan');
    expect(screen.getByRole('status').textContent).toContain('Ask AI isn’t included in your plan.');
    expect(screen.getByRole('status').textContent).not.toContain('Skills still run here.');
  });
});
