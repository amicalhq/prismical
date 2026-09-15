import type { TransportPort, TransportResponse } from '@prismical/app-contracts';
import { LOCAL_WORKSPACE } from '@prismical/desktop-contracts';
import { describe, expect, it, vi } from 'vitest';
import { migrateLocalPreferences } from '../../src/renderer/main/app/settings/local-preference-migration';

function fixture(values: Record<string, string> = {}) {
  const saved = new Map(Object.entries(values));
  const storage = {
    getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      saved.set(key, value);
    }),
  };
  const getStorage = vi.fn(() => storage);
  const request = vi
    .fn<TransportPort['request']>()
    .mockResolvedValue({ ok: true, status: 200, bodyJson: {} });
  return {
    saved,
    storage,
    getStorage,
    request,
    migrate: () => migrateLocalPreferences({ appMode: 'local', getStorage, request }),
  };
}

describe('local legacy preference migration', () => {
  it('does not access storage or transport in cloud mode', async () => {
    const { getStorage, request } = fixture({ 'prismical:auto-enhance': '0' });
    getStorage.mockImplementation(() => {
      throw new Error('storage must not be opened');
    });
    await migrateLocalPreferences({ appMode: 'cloud', getStorage, request });
    expect(getStorage).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('seeds explicit false choices and the local org model once, retaining hardware preferences', async () => {
    const recording = JSON.stringify({
      autoTranscribeNewNotes: false,
      microphonePriority: [{ deviceId: 'mic-1', name: 'USB' }],
      language: 'ja',
    });
    const f = fixture({
      'prismical:auto-enhance': '0',
      theme: 'dark',
      'prismical:recording-preferences:v1': recording,
      'ask.model.v1': JSON.stringify({ instanceId: 'local-ai', modelId: 'm1' }),
    });
    await f.migrate();
    expect(f.request).toHaveBeenCalledExactlyOnceWith({
      method: 'POST',
      path: '/apps/v1/me/preferences',
      body: {
        experience: { autoEnhance: false, theme: 'dark', autoTranscribeNewNotes: false },
        ask: { [LOCAL_WORKSPACE.orgId]: { instanceId: 'local-ai', modelId: 'm1' } },
      },
    });
    expect(f.saved.get('prismical:recording-preferences:v1')).toBe(recording);
    expect(f.saved.get('prismical:auto-enhance')).toBe('0');
    await f.migrate();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each<Record<string, string>>([
    {},
    {
      'prismical:auto-enhance': 'false',
      theme: 'sepia',
      'prismical:recording-preferences:v1': '{bad',
      'ask.model.v1': 'null',
    },
    {
      'prismical:recording-preferences:v1': '{"autoTranscribeNewNotes":"false"}',
      'ask.model.v1': '{"instanceId":"","modelId":"m"}',
    },
    {
      'prismical:recording-preferences:v1': '{"microphonePriority":[]}',
      'ask.model.v1': JSON.stringify({ instanceId: 'i', modelId: 'x'.repeat(201) }),
    },
  ])('skips absent or invalid legacy values: %j', async values => {
    const f = fixture(values);
    await f.migrate();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('keeps valid independent fields when another legacy JSON value is malformed', async () => {
    const f = fixture({
      theme: 'system',
      'prismical:recording-preferences:v1': '{bad',
      'ask.model.v1': '[]',
    });
    await f.migrate();
    expect(f.request).toHaveBeenCalledExactlyOnceWith({
      method: 'POST',
      path: '/apps/v1/me/preferences',
      body: { experience: { theme: 'system' } },
    });
  });

  it('tolerates blocked storage without a request', async () => {
    const f = fixture();
    f.getStorage.mockImplementation(() => {
      throw new Error('blocked');
    });
    await f.migrate();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each<TransportResponse>([
    { error: { code: 'INTERNAL' } },
    { ok: true, status: 503, bodyJson: {} },
  ])(
    'retries after a failed transport or HTTP response without marking completion',
    async response => {
      const f = fixture({ 'prismical:auto-enhance': '1' });
      f.request.mockResolvedValueOnce(response);
      await expect(f.migrate()).rejects.toThrow('Could not migrate local preferences');
      expect(f.storage.setItem).not.toHaveBeenCalled();
      await f.migrate();
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.storage.setItem).toHaveBeenCalledTimes(1);
    }
  );

  it('allows a failed completion marker to repeat only the safe POST', async () => {
    const f = fixture({ 'prismical:auto-enhance': '0' });
    f.storage.setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    await f.migrate();
    await f.migrate();
    expect(f.request.mock.calls.map(([request]) => request.method)).toEqual(['POST', 'POST']);
  });
});
