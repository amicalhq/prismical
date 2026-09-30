// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FileUploadPort, FileUploadRequest, FileUploadResult } from '@prismical/app-contracts';
const mocks = vi.hoisted(() => ({
  platform: 'web',
  fileUpload: undefined as FileUploadPort | undefined,
  capture: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  token: vi.fn(),
  fetch: vi.fn(),
  session: { activeSessionKey: 'owner', accounts: [{ sessionKey: 'owner', activeOrgId: 'org' }] },
  changed: (() => {}) as () => void,
}));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('./client', () => ({
  ME_PREFIX: '/apps/v1/me',
  apiClient: { get: mocks.get, post: mocks.post },
}));
vi.mock('../runtime', () => ({ coreApiBaseUrl: () => 'https://core.test' }));
vi.mock('./hooks/organizations', () => ({
  useOrganizations: () => ({ data: [{ orgId: 'org', orgUserId: 'member' }] }),
}));
vi.mock('../ports-context', () => {
  const auth = {
    getSession: () => mocks.session,
    getTokenForSession: mocks.token,
    onSessionChanged: (fn: () => void) => {
      mocks.changed = fn;
      return () => {};
    },
  };
  return { useSessionView: () => mocks.session, usePorts: () => ({ auth, env: { getEnv: () => ({ platform: mocks.platform }) }, analytics: { capture: mocks.capture }, fileUpload: mocks.fileUpload }) };
});
let requests: FakeXHR[];
class FakeXHR {
  upload = {};
  status = 200;
  timeout = 0;
  ontimeout = () => {};
  onload = () => {};
  onerror = () => {};
  onabort = () => {};
  open() {}
  setRequestHeader() {}
  send() {
    requests.push(this);
  }
  abort = vi.fn(() => this.onabort());
}
const record = {
  recordingId: 'rec',
  noteId: 'note',
  status: 'uploading',
  phase: 'uploading',
  uploadAttempt: 'attempt',
  uploadUrl: 'https://storage.test',
  error: null,
};
let useAudioImport: (typeof import('./recording-import'))['useAudioImport'];
const file = () => new File(['audio'], 'audio.wav');
beforeEach(async () => {
  mocks.platform = 'web';
  mocks.fileUpload = undefined;
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  requests = [];
  mocks.session = {
    activeSessionKey: 'owner',
    accounts: [{ sessionKey: 'owner', activeOrgId: 'org' }],
  };
  mocks.get.mockResolvedValue(null);
  mocks.post.mockResolvedValue(record);
  mocks.token.mockResolvedValue('test-token');
  mocks.fetch.mockResolvedValue({});
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('fetch', mocks.fetch);
  ({ useAudioImport } = await import('./recording-import'));
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('does not load or expose imports when disabled', async () => {
  const { result } = renderHook(() => useAudioImport(false));
  await act(async () => {
    await result.current.start('note', file(), 'en');
  });
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(result.current.state).toBeNull();
});
it('does not label another tab upload interrupted or let this tab cancel it', async () => {
  mocks.get.mockResolvedValue(record);
  const { result } = renderHook(() => useAudioImport(true));
  await act(async () => {});
  expect(result.current.state?.error).toBeNull();
  expect(result.current.state?.canCancel).toBeFalsy();
  await act(async () => {
    await result.current.cancel();
  });
  expect(mocks.post).not.toHaveBeenCalled();
});
it('guards a double click before asynchronous authentication resolves', async () => {
  let resolve!: (token: string) => void;
  mocks.token.mockImplementation(
    () =>
      new Promise<string>(done => {
        resolve = done;
      })
  );
  const { result } = renderHook(() => useAudioImport(true));
  await act(async () => {});
  let first!: Promise<void>;
  await act(async () => {
    first = result.current.start('note', file(), 'en');
    await expect(result.current.start('note', file(), 'en')).rejects.toThrow('audioImport.busy');
    resolve('test-token');
  });
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
  await act(async () => {
    requests[0]!.onerror();
    await first;
  });
});
it.each([
  ['a network failure', new Error('network')],
  ['a desktop transport failure', Object.assign(new Error('INTERNAL'), { status: 0 })],
])('reuses the request key after an ambiguous create response (%s)', async (_name, failure) => {
  mocks.post.mockRejectedValueOnce(failure).mockResolvedValue(record);
  const { result } = renderHook(() => useAudioImport(true));
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.start('note', file(), 'en');
  });
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(mocks.post.mock.calls[0]![1].requestKey).toBe(mocks.post.mock.calls[1]![1].requestKey);
  await act(async () => {
    requests[0]!.onerror();
    await start;
  });
});
it('aborts and sends a pinned keepalive cancellation on session switch', async () => {
  const { result } = renderHook(() => useAudioImport(true));
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.start('note', file(), 'en');
  });
  await act(async () => {
    mocks.session.activeSessionKey = 'other';
    mocks.changed();
    await start;
  });
  expect(requests[0]!.abort).toHaveBeenCalledOnce();
  expect(result.current.state).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledWith(
    expect.stringContaining('/rec/cancel'),
    expect.objectContaining({
      keepalive: true,
      headers: expect.objectContaining({
        Authorization: 'Bearer test-token',
        'x-active-org-id': 'org',
      }),
    })
  );
});
it('offers completion retry and does not cancel a committed upload on pagehide', async () => {
  mocks.post.mockResolvedValueOnce(record).mockRejectedValueOnce(new Error('complete unavailable'));
  const { result } = renderHook(() => useAudioImport(true));
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.start('note', file(), 'en');
  });
  await act(async () => {
    requests[0]!.onload();
    await start;
  });
  expect(result.current.state?.canComplete).toBe(true);
  window.dispatchEvent(new Event('pagehide'));
  expect(mocks.fetch).not.toHaveBeenCalled();
  mocks.post.mockResolvedValue({ ...record, status: 'pending', phase: 'checking' });
  await act(async () => {
    await result.current.complete();
  });
  expect(result.current.state?.record?.status).toBe('pending');
});
it('stops monitoring on unauthorized responses', async () => {
  mocks.get.mockResolvedValueOnce(record).mockRejectedValue({ status: 401 });
  const { result } = renderHook(() => useAudioImport(true));
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(result.current.state?.error).toBe('audioImport.reconnect');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(mocks.get).toHaveBeenCalledTimes(2);
});
it('bounds repeated transient polling errors', async () => {
  mocks.get.mockResolvedValueOnce(record).mockRejectedValue({ status: 503 });
  const { result } = renderHook(() => useAudioImport(true));
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(result.current.state?.error).toBe('audioImport.reconnect');
  expect(mocks.get).toHaveBeenCalledTimes(6);
});

it('does not create an import after the session changes while authentication is pending', async () => {
  let resolve!: (token: string) => void;
  mocks.token.mockImplementation(
    () =>
      new Promise<string>(done => {
        resolve = done;
      })
  );
  const { result } = renderHook(() => useAudioImport(true));
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.start('note', file(), 'en');
  });
  await act(async () => {
    mocks.session.activeSessionKey = 'other';
    mocks.changed();
    resolve('test-token');
    await start;
  });
  expect(mocks.post).not.toHaveBeenCalled();
  expect(result.current.state).toBeNull();
});
it('ignores a delayed cancellation after returning to the same account and starting a new upload', async () => {
  let resolveCancel!: (value: unknown) => void;
  mocks.post
    .mockResolvedValueOnce(record)
    .mockImplementationOnce(
      () =>
        new Promise(done => {
          resolveCancel = done;
        })
    )
    .mockResolvedValueOnce({ ...record, recordingId: 'new-recording' });
  const { result, rerender } = renderHook(() => useAudioImport(true));
  let first!: Promise<void>, cancellation!: Promise<void>, second!: Promise<void>;
  await act(async () => {
    first = result.current.start('note', file(), 'en');
  });
  await act(async () => {
    cancellation = result.current.cancel();
    await first;
  });
  await act(async () => {
    mocks.session.activeSessionKey = 'other';
    mocks.changed();
  });
  await act(async () => {
    mocks.session.activeSessionKey = 'owner';
    mocks.changed();
    rerender();
  });
  await act(async () => {
    second = result.current.start('note', file(), 'en');
  });
  await act(async () => {
    resolveCancel({ ...record, status: 'cancelled' });
    await cancellation;
  });
  expect(result.current.state?.record?.recordingId).toBe('new-recording');
  expect(result.current.state?.busy).toBe(true);
  await act(async () => {
    requests[1]!.onerror();
    await second;
  });
});

it('keeps a local upload error when polling an uploading row with no server error', async () => {
  const { result } = renderHook(() => useAudioImport(true));
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.start('note', file(), 'en');
  });
  await act(async () => {
    requests[0]!.onerror();
    await start;
  });
  expect(result.current.state?.error).toBe('audioImport.interrupted');
  mocks.get.mockResolvedValue(record);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(result.current.state?.error).toBe('audioImport.interrupted');
  expect(result.current.state?.canCancel).toBe(true);
  mocks.get.mockResolvedValue({ ...record, status: 'pending', phase: 'checking' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(result.current.state?.error).toBeNull();
});
it('sends a pinned keepalive cancellation on pagehide while this tab uploads', async () => {
  const { result } = renderHook(() => useAudioImport(true));
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.start('note', file(), 'en');
  });
  window.dispatchEvent(new Event('pagehide'));
  expect(mocks.fetch).toHaveBeenCalledWith(
    'https://core.test/apps/v1/me/recording-imports/rec/cancel',
    expect.objectContaining({
      keepalive: true,
      method: 'POST',
      body: JSON.stringify({ uploadAttempt: 'attempt' }),
      headers: expect.objectContaining({
        Authorization: 'Bearer test-token',
        'x-active-org-id': 'org',
      }),
    })
  );
  await act(async () => {
    requests[0]!.onerror();
    await start;
  });
});

it.each([true, false])(
  'only enables recovery cancellation for a matching create request (%s)',
  async matchesRequest => {
    const { result } = renderHook(() => useAudioImport(true));
    await act(async () => {});
    mocks.post.mockRejectedValue(new Error('create response lost'));
    mocks.get.mockImplementation(async () => ({
      ...record,
      requestKey: matchesRequest ? mocks.post.mock.calls[0]![1].requestKey : 'another-tab-request',
    }));
    await act(async () => {
      await result.current.start('note', file(), 'en');
    });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(result.current.state?.canCancel).toBe(matchesRequest);
    expect(result.current.state?.observedOnly).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.state?.canCancel).toBe(matchesRequest);
    expect(result.current.state?.observedOnly).toBe(true);
    mocks.post.mockResolvedValue({ ...record, status: 'cancelled' });
    await act(async () => {
      await result.current.cancel();
    });
    expect(mocks.post).toHaveBeenCalledTimes(matchesRequest ? 3 : 2);
  }
);

it('times out stalled uploads with private-safe telemetry and a cancellable error', async () => {
  const { result } = renderHook(() => useAudioImport(true));
  await act(async () => {});
  let pending!: Promise<void>;
  await act(async () => { pending = result.current.start('note', file(), 'en'); });
  expect(requests[0]!.timeout).toBe(30 * 60_000);
  await act(async () => { requests[0]!.ontimeout(); await pending; });
  expect(result.current.state?.error).toBe('audioImport.interrupted');
  expect(result.current.state?.canCancel).toBe(true);
  expect(mocks.capture).toHaveBeenCalledWith('audio_import_upload', {
    outcome: 'failed', stage: 'upload', size_bytes: 5, restart: false,
  });
  const captured = JSON.stringify(mocks.capture.mock.calls);
  expect(captured).not.toContain('audio.wav');
  expect(captured).not.toContain('storage.test');
  expect(captured).not.toContain('test-token');
});

it('cancels an abandoned desktop upload through the active account transport', async () => {
  mocks.platform = 'darwin';
  const { result } = renderHook(() => useAudioImport(true));
  let pending!: Promise<unknown>;
  await act(async () => { pending = result.current.start('note', file(), 'en').catch(() => {}); });
  expect(requests).toHaveLength(1);
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.post).toHaveBeenCalledWith('/apps/v1/me/recording-imports/rec/cancel', { uploadAttempt: 'attempt' }, { activeOrgId: 'org', authToken: 'test-token' });
  await act(async () => { requests[0]!.abort(); await pending; });
});

it('does not send desktop abandonment cancellation under a switched account', async () => {
  mocks.platform = 'darwin';
  const { result } = renderHook(() => useAudioImport(true));
  let pending!: Promise<unknown>;
  await act(async () => { pending = result.current.start('note', file(), 'en').catch(() => {}); });
  expect(requests).toHaveLength(1);
  mocks.post.mockClear();
  mocks.session = { activeSessionKey: 'other', accounts: [{ sessionKey: 'other', activeOrgId: 'other-org' }] };
  await act(async () => { mocks.changed(); await pending; });
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(requests[0]!.abort).toHaveBeenCalledOnce();
});

it('sends the file through the platform upload port instead of the page', async () => {
  let request!: FileUploadRequest;
  let finish!: (result: FileUploadResult) => void;
  mocks.fileUpload = {
    put: vi.fn(next => {
      request = next;
      return new Promise<FileUploadResult>(done => { finish = done; });
    }),
  };
  const { result } = renderHook(() => useAudioImport(true));
  let pending!: Promise<void>;
  await act(async () => { pending = result.current.start('note', new File(['audio'], 'audio.wav', { type: 'audio/wav' }), 'en'); });
  expect(requests).toHaveLength(0);
  expect(request).toMatchObject({ url: 'https://storage.test', contentType: 'audio/wav' });
  act(() => request.onProgress(40));
  expect(result.current.state?.progress).toBe(40);
  await act(async () => { finish({ ok: true }); await pending; });
  expect(mocks.post).toHaveBeenLastCalledWith('/apps/v1/me/recording-imports/rec/complete', { uploadAttempt: 'attempt' }, { activeOrgId: 'org', authToken: 'test-token' });
});

it.each([
  ['rejected', 'audioImport.uploadFailed'],
  ['interrupted', 'audioImport.interrupted'],
] as const)('shows a %s port upload as its upload error', async (reason, message) => {
  mocks.fileUpload = { put: vi.fn(async () => ({ ok: false as const, reason })) };
  const { result } = renderHook(() => useAudioImport(true));
  await act(async () => { await result.current.start('note', file(), 'en'); });
  expect(result.current.state?.error).toBe(message);
  expect(result.current.state?.canCancel).toBe(true);
});

it('aborts a port upload when the user cancels', async () => {
  let signal!: AbortSignal;
  mocks.fileUpload = {
    put: vi.fn(next => {
      signal = next.signal;
      return new Promise<FileUploadResult>(done => {
        next.signal.addEventListener('abort', () => done({ ok: false, reason: 'cancelled' }));
      });
    }),
  };
  const { result } = renderHook(() => useAudioImport(true));
  let pending!: Promise<void>;
  await act(async () => { pending = result.current.start('note', file(), 'en'); });
  expect(signal.aborted).toBe(false);
  mocks.post.mockResolvedValue({ ...record, status: 'cancelled' });
  await act(async () => { await result.current.cancel(); await pending; });
  expect(signal.aborted).toBe(true);
  expect(result.current.state?.record?.status).toBe('cancelled');
});

it('does not retry a create that core refused', async () => {
  mocks.post.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
  const { result } = renderHook(() => useAudioImport(true));
  await act(async () => { await result.current.start('note', file(), 'en'); });
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(result.current.state?.error).toBe('conflict');
});
