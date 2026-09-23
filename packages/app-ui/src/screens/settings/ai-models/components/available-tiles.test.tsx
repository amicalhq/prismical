// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROVIDER_FEATURE_KEYS, PROVIDER_TYPE_COMING_SOON, PROVIDER_TYPE_LABELS, PROVIDER_TYPES } from '../../../../lib/providers';
import AvailableTiles from './available-tiles';

const flags = vi.hoisted(() => ({ values: {} as Record<string, boolean>, plan: 'plan_free' }));
vi.mock('@prismical/app-client', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => flags.values[key] ?? false, isResolved: true }),
  useEntitlements: () => ({ entitlements: { planExternalId: flags.plan }, isResolved: true }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { provider?: string }) =>
      key === 'settings.aiModels.available.requestProvider'
        ? 'Request Provider'
        : key === 'settings.aiModels.planGate.lockedAria'
          ? `${values?.provider} - available in Pro`
          : key === 'settings.aiModels.planGate.tier.lockedAria'
            ? `${values?.provider} - available on higher tiers`
            : 'Coming soon',
  }),
}));
afterEach(() => { cleanup(); flags.values = {}; flags.plan = 'plan_free'; });

it('hides every unfinished provider for customers and keeps implemented providers actionable', () => {
  flags.values = { openaiByok: true, openRouterByok: true, googleGeminiByok: true, deepgramByok: true };
  const add = vi.fn();
  render(<AvailableTiles onAddCloud={add} byokAccess="allowed" onLocked={vi.fn()} />);
  for (const provider of Object.values(PROVIDER_TYPES).filter(type => PROVIDER_TYPE_COMING_SOON[type])) {
    expect(screen.queryByRole('button', { name: PROVIDER_TYPE_LABELS[provider] })).toBeNull();
  }
  expect(screen.getAllByRole('button')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
  expect(add).toHaveBeenCalledWith('openai');
  const request = screen.getByRole('link', { name: 'Request Provider' });
  expect(request.getAttribute('href')).toBe('mailto:help@prismical.ai?subject=Request%20a%20Provider');
  expect(request.className).toContain('border-dashed');
  expect(request.parentElement?.lastElementChild).toBe(request);
});

it('shows unfinished providers as disabled for testers and follows changed organization flags', () => {
  flags.values = Object.fromEntries(Object.values(PROVIDER_FEATURE_KEYS).map(key => [key, true]));
  const { rerender } = render(<AvailableTiles onAddCloud={vi.fn()} byokAccess="allowed" onLocked={vi.fn()} />);
  for (const provider of Object.values(PROVIDER_TYPES).filter(type => PROVIDER_TYPE_COMING_SOON[type])) {
    expect((screen.getByRole('button', { name: PROVIDER_TYPE_LABELS[provider] }) as HTMLButtonElement).disabled).toBe(true);
  }
  flags.values = { anthropicByok: true };
  rerender(<AvailableTiles onAddCloud={vi.fn()} byokAccess="allowed" onLocked={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'OpenAI' })).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Anthropic' }) as HTMLButtonElement).disabled).toBe(true);
});

it('does not flash providers before flags resolve', () => {
  render(<AvailableTiles onAddCloud={vi.fn()} byokAccess="allowed" onLocked={vi.fn()} />);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByRole('link', { name: 'Request Provider' })).toBeTruthy();
});

it('keeps locked provider tiles clickable so they explain the plan instead of opening the form', () => {
  flags.values = { openaiByok: true, deepgramByok: true };
  const add = vi.fn();
  const onLocked = vi.fn();
  render(<AvailableTiles onAddCloud={add} byokAccess="locked" onLocked={onLocked} />);
  const tile = screen.getByRole('button', { name: 'OpenAI - available in Pro' }) as HTMLButtonElement;
  expect(tile.disabled).toBe(false);
  fireEvent.click(tile);
  expect(onLocked).toHaveBeenCalledTimes(1);
  expect(add).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Request Provider' })).toBeTruthy();
});

it('holds provider tiles inert without upselling while the plan loads', () => {
  flags.values = { openaiByok: true };
  const onLocked = vi.fn();
  const add = vi.fn();
  render(<AvailableTiles onAddCloud={add} byokAccess="pending" onLocked={onLocked} />);
  expect(screen.queryByRole('button', { name: /available in Pro/ })).toBeNull();
  const tile = screen.getByRole('button', { name: 'OpenAI' }) as HTMLButtonElement;
  expect(tile.disabled).toBe(true);
  expect(tile.querySelector('.lucide-lock')).toBeNull();
  fireEvent.click(tile);
  expect(onLocked).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
});

it('names the tier, not Pro, on a lifetime-deal plan', () => {
  flags.values = { openaiByok: true };
  flags.plan = 'plan_appsumo_tier_1';
  render(<AvailableTiles onAddCloud={vi.fn()} byokAccess="locked" onLocked={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'OpenAI - available on higher tiers' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /available in Pro/ })).toBeNull();
});
