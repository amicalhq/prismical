// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PROVIDER_FEATURE_KEYS,
  PROVIDER_TYPE_COMING_SOON,
  PROVIDER_TYPE_LABELS,
  PROVIDER_TYPES,
} from '../../../../lib/providers';
import AvailableTiles from './available-tiles';

const flags = vi.hoisted(() => ({ values: {} as Record<string, boolean> }));
vi.mock('@prismical/app-client', () => ({
  useFeatureFlags: () => ({
    isEnabled: (key: string) => flags.values[key] ?? false,
    isResolved: true,
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'settings.aiModels.available.requestProvider' ? 'Request Provider' : 'Coming soon',
  }),
}));
afterEach(() => {
  cleanup();
  flags.values = {};
});

it('hides every unfinished provider for customers and keeps implemented providers actionable', () => {
  flags.values = {
    openaiByok: true,
    openRouterByok: true,
    googleGeminiByok: true,
    deepgramByok: true,
  };
  const add = vi.fn();
  render(<AvailableTiles onAddCloud={add} />);
  for (const provider of Object.values(PROVIDER_TYPES).filter(
    type => PROVIDER_TYPE_COMING_SOON[type]
  )) {
    expect(screen.queryByRole('button', { name: PROVIDER_TYPE_LABELS[provider] })).toBeNull();
  }
  expect(screen.getAllByRole('button')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
  expect(add).toHaveBeenCalledWith('openai');
});

it('shows unfinished providers as disabled for testers and follows changed organization flags', () => {
  flags.values = Object.fromEntries(Object.values(PROVIDER_FEATURE_KEYS).map(key => [key, true]));
  const { rerender } = render(<AvailableTiles onAddCloud={vi.fn()} />);
  for (const provider of Object.values(PROVIDER_TYPES).filter(
    type => PROVIDER_TYPE_COMING_SOON[type]
  )) {
    expect(
      (screen.getByRole('button', { name: PROVIDER_TYPE_LABELS[provider] }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  }
  flags.values = { anthropicByok: true };
  rerender(<AvailableTiles onAddCloud={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'OpenAI' })).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Anthropic' }) as HTMLButtonElement).disabled).toBe(
    true
  );
});

it('does not flash providers before flags resolve', () => {
  render(<AvailableTiles onAddCloud={vi.fn()} />);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
