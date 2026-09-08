// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillToolsPicker } from './skill-tools-picker';

const state = vi.hoisted(() => ({
  flags: {} as Partial<Record<string, boolean>>,
  servers: vi.fn(() => ({ data: [] })),
}));
vi.mock('@prismical/app-client', () => ({
  useFeatureFlag: (key: string) => ({ enabled: state.flags[key] === true }),
  useMcpServers: state.servers,
  useMcpServer: () => ({ data: undefined }),
}));
vi.mock('@prismical/app-i18n', () => ({ useApplicationLocale: () => ({ resolvedLocale: 'en' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([
  {},
  { integrations: true },
  { integrations: true, skillMcpTools: false },
  { integrations: false, skillMcpTools: true },
])('hides tool selection and disables fetching when gated: %j', flags => {
  state.flags = flags;
  const { container } = render(<SkillToolsPicker value={[]} onChange={vi.fn()} />);
  expect(container.innerHTML).toBe('');
  expect(state.servers).toHaveBeenCalledWith(false);
});

it('shows tool selection only when both gates are enabled and hides it after revocation', () => {
  state.flags = { integrations: true, skillMcpTools: true };
  const view = render(<SkillToolsPicker value={[]} onChange={vi.fn()} />);
  expect(
    screen.getByRole('button', { name: 'settings.skillLibrary.actions.addTools' })
  ).toBeTruthy();
  expect(state.servers).toHaveBeenCalledWith(true);
  state.flags.skillMcpTools = false;
  view.rerender(<SkillToolsPicker value={[]} onChange={vi.fn()} />);
  expect(
    screen.queryByRole('button', { name: 'settings.skillLibrary.actions.addTools' })
  ).toBeNull();
  expect(state.servers).toHaveBeenLastCalledWith(false);
});
