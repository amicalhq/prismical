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
}));
vi.mock('@prismical/app-client', () => ({
  useNotes: () => ({ data: [] }),
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
const i18n = createApplicationI18nSync('en');

function composer(props: { withSkills?: boolean } = {}) {
  const ref = React.createRef<import('./ask-composer').AskComposerHandle>();
  const ui = (
    <I18nextProvider i18n={i18n}>
      <AskComposer
        ref={ref}
        busy={false}
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

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.askAi = true;
});

describe('AskComposer plan gate', () => {
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
