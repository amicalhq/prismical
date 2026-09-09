import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../runtime', () => ({
  coreApiBaseUrl: () => 'https://core.test',
  getClientTransport: () => null,
}));
vi.mock('./auth', () => ({
  getAuthHeaders: () => ({}),
  getAuthHeadersForToken: () => ({}),
  onUnauthorized: vi.fn(),
}));
import { finalizeRecording } from './transcription';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('recording completion acknowledgement', () => {
  it.each([
    {},
    { result: { id: 'other', status: 'completed' } },
    { result: { id: 'rec_1', status: 'recording' } },
  ])('retains recovery for an invalid acknowledgement: %j', async body => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body)))
    );
    await expect(finalizeRecording('rec_1', 1000)).rejects.toThrow(
      'Invalid recording completion acknowledgement'
    );
  });
  it('bounds the request and accepts only its completed recording', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ result: { id: 'rec_1', status: 'completed' } }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await expect(finalizeRecording('rec_1', 1000)).resolves.toMatchObject({
      id: 'rec_1',
      status: 'completed',
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
  it('does not mistake a timed-out response body for successful completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new DOMException('Timed out', 'TimeoutError');
        },
      }))
    );
    await expect(finalizeRecording('rec_1', 1000)).rejects.toThrow(
      'Invalid recording completion acknowledgement'
    );
  });
});
