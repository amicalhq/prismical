import type { AuthPort, SessionView } from '@prismical/app-contracts';
import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTransportPort } from '../../src/renderer/main/app/ports/desktop-ports';

vi.mock('../../src/renderer/main/app/router', () => ({ router: {} }));
vi.mock('../../src/renderer/main/app/analytics/posthog', () => ({ desktopAnalyticsPort: {} }));

afterEach(() => vi.unstubAllGlobals());

const signedIn = (sub: string): SessionView => ({
  state: 'signed-in',
  activeSub: sub,
  activeSessionKey: `session_${sub}`,
  accounts: [{ sub, sessionKey: `session_${sub}`, email: `${sub}@example.com` }],
});
const success: TransportResponse = { ok: true, status: 200, bodyJson: {} };

describe('desktop unary transport ownership', () => {
  it('pins a preference write before delayed IPC dispatch and reads the new owner for the next request', async () => {
    let view = signedIn('account_a');
    const auth: Pick<AuthPort, 'getSession'> = { getSession: () => view };
    let finishDispatch!: (response: TransportResponse) => void;
    const ipc = vi
      .fn<(request: TransportRequest) => Promise<TransportResponse>>()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishDispatch = resolve;
          })
      )
      .mockResolvedValue(success);
    vi.stubGlobal('window', { desktop: { transport: { request: ipc } } });
    const port = createTransportPort(auth, 'cloud');
    const request = {
      method: 'PATCH' as const,
      path: '/apps/v1/me/preferences',
      body: { experience: { autoEnhance: false } },
    };

    const pending = port.request(request);
    expect(ipc).toHaveBeenCalledExactlyOnceWith({ ...request, expectedAccountId: 'account_a' });

    // Main changes accounts while the first IPC exchange is queued. Its ownership
    // guard rejects the pinned request instead of applying account A's patch to B.
    view = signedIn('account_b');
    finishDispatch({ error: { code: 'INTERNAL' } });
    expect(await pending).toEqual({ error: { code: 'INTERNAL' } });
    expect(ipc.mock.calls[0][0].expectedAccountId).toBe('account_a');

    expect(await port.request(request)).toEqual(success);
    expect(ipc).toHaveBeenLastCalledWith({ ...request, expectedAccountId: 'account_b' });
  });

  it('keeps local requests accountless and preserves JSON Date normalization', async () => {
    const getSession = vi.fn<AuthPort['getSession']>(() => ({ state: 'signed-out', accounts: [] }));
    const ipc = vi
      .fn<(request: TransportRequest) => Promise<TransportResponse>>()
      .mockResolvedValue(success);
    vi.stubGlobal('window', { desktop: { transport: { request: ipc } } });
    const port = createTransportPort({ getSession }, 'local');
    const updatedAt = new Date('2026-09-15T12:00:00.000Z');

    expect(
      await port.request({
        method: 'POST',
        path: '/apps/v1/me/notes',
        query: { includeBody: '1' },
        body: { title: 'Local note', updatedAt, meta: { absent: undefined } },
      })
    ).toEqual(success);
    expect(ipc).toHaveBeenCalledExactlyOnceWith({
      method: 'POST',
      path: '/apps/v1/me/notes',
      query: { includeBody: '1' },
      body: { title: 'Local note', updatedAt: '2026-09-15T12:00:00.000Z', meta: {} },
    });
    expect(updatedAt).toBeInstanceOf(Date);
  });

  it('rejects a cloud request without an account before calling IPC', async () => {
    const ipc = vi
      .fn<(request: TransportRequest) => Promise<TransportResponse>>()
      .mockResolvedValue(success);
    vi.stubGlobal('window', { desktop: { transport: { request: ipc } } });
    const port = createTransportPort(
      { getSession: () => ({ state: 'signed-out', accounts: [] }) },
      'cloud'
    );

    expect(await port.request({ method: 'GET', path: '/apps/v1/me/preferences' })).toEqual({
      error: { code: 'INTERNAL' },
    });
    expect(ipc).not.toHaveBeenCalled();
  });
});
