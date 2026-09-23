// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import DefaultCard from './default-card';

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

async function mount(useCase: 'transcription' | 'formatting', byokAccess: 'allowed' | 'locked' | 'pending') {
  const i18n = await createApplicationI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <DefaultCard
        useCase={useCase}
        title={useCase}
        description=""
        Icon={() => null}
        byokAccess={byokAccess}
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

it.each(['allowed', 'pending'] as const)('says nothing about the plan when BYOK is %s', async access => {
  await mount('transcription', access);
  expect(screen.queryByText('Not in your plan')).toBeNull();
});
