import { afterEach, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { finalizeRecording } from './transcription';

vi.mock('./client', () => ({ apiClient: { put: vi.fn() }, ME_PREFIX: '/apps/v1/me' }));
afterEach(() => vi.resetAllMocks());
it.each([
  null,
  {},
  { result: {} },
  { result: { id: 'other', status: 'completed' } },
  { result: { id: 'rec_test', status: 'recording' } },
])('rejects an invalid Stop acknowledgement: %j', async response => {
  vi.mocked(apiClient.put).mockResolvedValue(response);
  await expect(finalizeRecording('rec_test', 1000)).rejects.toThrow(
    'Invalid recording completion acknowledgement'
  );
});
it('accepts only a completed response for the requested recording', async () => {
  const result = { id: 'rec_test', status: 'completed' };
  vi.mocked(apiClient.put).mockResolvedValue({ result });
  await expect(finalizeRecording('rec_test', 1000)).resolves.toEqual(result);
});
