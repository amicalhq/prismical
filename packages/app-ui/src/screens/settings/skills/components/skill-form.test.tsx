// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import type { Skill } from '@prismical/app-contracts';
import { SkillForm } from './skill-form';

const mocks = vi.hoisted(() => ({
  advanced: false,
  integrations: false,
  tools: false,
  create: vi.fn().mockResolvedValue({ id: 'created' }),
  update: vi.fn().mockResolvedValue(undefined),
  push: vi.fn(),
}));
vi.mock('@prismical/app-client', () => ({
  useFeatureFlags: () => ({
    isEnabled: (key: string) =>
      key === 'skillAdvancedSettings'
        ? mocks.advanced
        : key === 'integrations'
          ? mocks.integrations
          : mocks.tools,
  }),
  useNavigation: () => ({ push: mocks.push }),
}));
vi.mock('./skills-store', () => ({
  useSkills: () => ({ create: mocks.create, update: mocks.update }),
}));
vi.mock('./skill-tools-picker', () => ({
  SkillToolsPicker: ({ onChange }: { onChange: (tools: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['mcp:server:new'])}>
      Change tools
    </button>
  ),
}));
vi.mock('./delete-skill-dialog', () => ({ DeleteSkillDialog: () => null }));
beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
);
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  vi.clearAllMocks();
  mocks.advanced = false;
  mocks.integrations = false;
  mocks.tools = false;
});
async function mount(existing?: Skill) {
  const i18n = await createApplicationI18n('en');
  const view = () => (
    <I18nextProvider i18n={i18n}>
      <SkillForm mode={existing ? 'edit' : 'new'} existing={existing} />
    </I18nextProvider>
  );
  const result = render(view());
  return { ...result, rerenderForm: () => result.rerender(view()) };
}
it('shows the simple form and creates a skill with safe hidden defaults', async () => {
  const { container } = await mount();
  expect(screen.queryByText('Advanced settings')).toBeNull();
  expect(screen.getByLabelText('Include transcript')).toBeTruthy();
  expect(screen.getByLabelText('Enabled')).toBeTruthy();
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  expect(screen.getByText('Add a section')).toBeTruthy();
  expect(screen.getByText('Rewrite entire note')).toBeTruthy();
  fireEvent.change(container.querySelector('#name')!, { target: { value: 'My skill' } });
  fireEvent.change(container.querySelector('#body')!, { target: { value: 'Summarize the note.' } });
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  expect(mocks.create.mock.calls[0]![0]).toMatchObject({
    enabled: true,
    config: {
      outputTarget: 'note-body',
      inputs: { transcript: false },
      editingOptions: 'append-section',
      surface: ['dock'],
      defaultSkill: false,
      modeAgnosticPrompt: false,
      askScope: 'multi-note',
    },
  });
});
it.each(['note-body', 'note-title'] as const)(
  'preserves hidden settings when editing a %s skill',
  async outputTarget => {
    const config = {
      outputTarget,
      inputs: { transcript: true },
      editingOptions: 'inline-rewrite',
      surface: ['inline', 'ask'],
      defaultSkill: true,
      modeAgnosticPrompt: true,
      askScope: 'single-note',
    } as const;
    const existing = {
      id: 'saved',
      name: 'Saved skill',
      body: 'Rewrite this.',
      description: '',
      enabled: true,
      config,
      allowedTools: ['mcp:server:tool'],
    } as unknown as Skill;
    const { container } = await mount(existing);
    expect(screen.queryByText('Advanced settings')).toBeNull();
    expect(
      screen.getByText('This skill uses an experimental output setting. Saving keeps it unchanged.')
    ).toBeTruthy();
    fireEvent.change(container.querySelector('#name')!, { target: { value: 'Renamed skill' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![1]).toMatchObject({
      name: 'Renamed skill',
      config,
      allowedTools: existing.allowedTools,
    });
  }
);
it('retains experimental settings for opted-in accounts', async () => {
  mocks.advanced = true;
  const { container } = await mount();
  expect(screen.getByText('Advanced settings')).toBeTruthy();
  expect(container.querySelector('#title-output')).toBeTruthy();
  expect(container.querySelector('#mode-agnostic')).toBeTruthy();
  expect(container.querySelector('#s-inline')).toBeTruthy();
  expect(container.querySelector('#m-ir')).toBeTruthy();
});

const savedSkill = (editingOptions = 'append-section') =>
  ({
    id: 'saved',
    name: 'Saved skill',
    body: 'Rewrite this.',
    description: '',
    enabled: true,
    config: { outputTarget: 'note-body', editingOptions, surface: ['dock'] },
    allowedTools: ['mcp:server:original'],
  }) as Skill;

it.each([undefined, 'append-section', 'replace-doc'] as const)(
  'drops a dirty experimental mode after revocation (saved mode: %s)',
  async savedMode => {
    mocks.advanced = true;
    const { container, rerenderForm } = await mount(savedMode ? savedSkill(savedMode) : undefined);
    fireEvent.change(container.querySelector('#name')!, { target: { value: 'My skill' } });
    fireEvent.change(container.querySelector('#body')!, { target: { value: 'Summarize.' } });
    fireEvent.click(container.querySelector('#m-ir')!);
    mocks.advanced = false;
    rerenderForm();
    expect(container.querySelector('#m-ir')).toBeNull();
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(savedMode ? mocks.update : mocks.create).toHaveBeenCalled());
    const payload = savedMode ? mocks.update.mock.calls[0]![1] : mocks.create.mock.calls[0]![0];
    expect(payload.config.editingOptions).toBe(savedMode ?? 'append-section');
    expect(
      container
        .querySelector(savedMode === 'replace-doc' ? '#m-rd' : '#m-as')
        ?.getAttribute('aria-checked')
    ).toBe('true');
  }
);

it.each(['integrations', 'tools'] as const)(
  'preserves saved tool grants after revoking %s',
  async gate => {
    mocks.integrations = true;
    mocks.tools = true;
    const existing = savedSkill();
    const { container, rerenderForm } = await mount(existing);
    fireEvent.click(screen.getByRole('button', { name: 'Change tools' }));
    mocks[gate] = false;
    rerenderForm();
    expect(screen.queryByRole('button', { name: 'Change tools' })).toBeNull();
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![1].allowedTools).toEqual(existing.allowedTools);
  }
);

it('shows tools for the effective output target after advanced access is revoked', async () => {
  mocks.advanced = true;
  mocks.integrations = true;
  mocks.tools = true;
  const { container, rerenderForm } = await mount(savedSkill());
  fireEvent.click(container.querySelector('#title-output')!);
  expect(screen.queryByRole('button', { name: 'Change tools' })).toBeNull();
  mocks.advanced = false;
  rerenderForm();
  expect(screen.getByRole('button', { name: 'Change tools' })).toBeTruthy();
});

it('clears saved tool grants when converting a body skill to title output', async () => {
  mocks.advanced = true;
  const { container } = await mount(savedSkill());
  fireEvent.click(container.querySelector('#title-output')!);
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.update.mock.calls[0]![1]).toMatchObject({
    config: { outputTarget: 'note-title' },
    allowedTools: null,
  });
});
