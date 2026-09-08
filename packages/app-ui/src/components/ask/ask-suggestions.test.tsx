// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { I18nextProvider } from 'react-i18next';

const mocks = vi.hoisted(() => ({ askAi: true }));
const dockSkill = {
  id: 'skl_cleanup',
  name: 'Cleanup',
  enabled: true,
  config: { outputTarget: 'note-body', surface: ['dock'] },
};
const promptSkill = {
  id: 'skl_brief',
  name: 'Brief me',
  body: 'Brief me on this',
  enabled: true,
  config: { outputTarget: 'note-body', surface: ['ask'] },
};
vi.mock('@prismical/app-client', () => ({
  useSkillsList: () => ({ data: [dockSkill, promptSkill] }),
  askSkills: () => [promptSkill],
  useEntitlements: () => ({ entitlements: { features: { askAi: mocks.askAi } }, isResolved: true }),
}));
vi.mock('../../shell/current-note-context', () => ({
  useCurrentNote: () => ({ currentNote: { noteId: 'nt_1', title: 'Weekly sync' } }),
}));
const { AskSuggestions } = await import('./ask-suggestions');
const i18n = createApplicationI18nSync('en');

function suggestions(props: { canRunSkills: boolean }) {
  return (
    <I18nextProvider i18n={i18n}>
      <AskSuggestions
        canRunSkills={props.canRunSkills}
        onAsk={() => {}}
        onPickPrompt={() => {}}
        onInsertSkill={() => {}}
      />
    </I18nextProvider>
  );
}

afterEach(cleanup);
beforeEach(() => {
  mocks.askAi = true;
});

describe('AskSuggestions plan gate', () => {
  it('offers starter questions and skill chips when Ask is in the plan', () => {
    render(suggestions({ canRunSkills: true }));
    expect(screen.getByRole('button', { name: 'Summarize this note' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cleanup/ })).toBeTruthy();
  });

  it('on a note without Ask: no questions, the skill chips stay', () => {
    mocks.askAi = false;
    render(suggestions({ canRunSkills: true }));
    expect(screen.queryByRole('button', { name: 'Summarize this note' })).toBeNull();
    expect(screen.getByRole('button', { name: /Cleanup/ })).toBeTruthy();
  });

  it('off a note without Ask: the prompt-filling chips go too, since their prompt is an ask', () => {
    mocks.askAi = false;
    render(suggestions({ canRunSkills: false }));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
