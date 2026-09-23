// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import DefaultCard from './default-card';
import type { DeviceTranscription } from './device-transcription';

const instance = { id: 'inst_saved', provider: 'openai', label: 'Work key', config: {}, catalog: [] };
vi.mock('@prismical/app-client', () => ({ PRISMICAL_CLOUD_INSTANCE_ID: 'prismical-cloud' }));
vi.mock('./ai-models-store', () => ({
  useAIModels: () => ({
    defaults: {
      transcription: { instanceId: 'inst_saved', modelId: 'whisper-1' },
      formatting: { instanceId: 'inst_saved', modelId: 'gpt-5' },
    },
    getInstance: () => instance,
  }),
}));
afterEach(cleanup);

async function mount(useCase: 'transcription' | 'formatting', byokAccess: 'allowed' | 'locked' | 'pending', deviceTranscription?: DeviceTranscription) {
  const i18n = await createApplicationI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <DefaultCard
        useCase={useCase}
        title={useCase}
        description=""
        Icon={() => null}
        byokAccess={byokAccess}
        deviceTranscription={deviceTranscription}
        onChange={vi.fn()}
      />
    </I18nextProvider>
  );
}

it('tells a downgraded org that text generation already runs on Prismical Cloud', async () => {
  await mount('formatting', 'locked');
  expect(screen.getByText('Not in your plan')).toBeTruthy();
  expect(screen.getByText(/using Prismical Cloud until you upgrade/)).toBeTruthy();
});

it('asks a downgraded org to switch transcription, since recordings do not fall back', async () => {
  await mount('transcription', 'locked');
  expect(screen.getByText(/switch to Prismical Cloud to keep recording/)).toBeTruthy();
  expect(screen.queryByText(/until you upgrade/)).toBeNull();
});

it('shows the active Whisper model instead of a saved account provider on a locked plan', async () => {
  await mount('transcription', 'locked', {
    models: [{ id: 'base-en', name: 'Whisper Base (English)', installed: true }],
    active: true,
    loading: false,
    selectedModelId: 'base-en',
    onSelect: vi.fn(),
  });
  expect(screen.getByText('Whisper Base (English)')).toBeTruthy();
  expect(screen.getByText('On this device')).toBeTruthy();
  expect(screen.queryByText('OpenAI')).toBeNull();
  expect(screen.queryByText('whisper-1')).toBeNull();
  expect(screen.queryByText('Not in your plan')).toBeNull();
  expect(screen.queryByText(/switch to Prismical Cloud to keep recording/)).toBeNull();
});

it('warns when the active on-device model is no longer installed', async () => {
  await mount('transcription', 'allowed', {
    models: [{ id: 'base-en', name: 'Whisper Base (English)', installed: false }],
    active: true,
    loading: false,
    selectedModelId: 'base-en',
    onSelect: vi.fn(),
  });
  expect(screen.getByText('On-device model unavailable')).toBeTruthy();
  expect(screen.queryByText('OpenAI')).toBeNull();
});

it.each(['allowed', 'pending'] as const)('says nothing about the plan when BYOK is %s', async access => {
  await mount('transcription', access);
  expect(screen.queryByText('Not in your plan')).toBeNull();
});


it('does not display the account model while the active device catalogue loads', async () => {
  await mount('transcription', 'allowed', {
    models: [], active: true, loading: true, selectedModelId: null, onSelect: vi.fn(),
  });
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(screen.queryByText('OpenAI')).toBeNull();
  expect(screen.queryByText('On-device model unavailable')).toBeNull();
});
