/**
 * Preload-side gate for the test-only E2E surface. The main
 * process's handler absence outside E2E is pinned in tests/services/ipc.test.ts;
 * this pins the RENDERER-facing half — without the --prismical-e2e argv switch
 * (injected by WindowRegistry only when config.isE2E) the bridge exposes NO
 * `e2e` key at all.
 */
import { describe, expect, it } from 'vitest';
import { E2E_ARGV_SWITCH, makeE2ESurface } from '../../src/preload/e2e-surface';

const PROD_ARGV = ['/Applications/Prismical.app/Contents/MacOS/Prismical', '--no-sandbox'];

describe('preload e2e surface gate', () => {
  it('without --prismical-e2e the bridge fragment has NO e2e key (not even undefined)', () => {
    const surface = makeE2ESurface(PROD_ARGV, () => Promise.resolve(null));
    expect(Object.keys(surface)).toEqual([]);
    expect('e2e' in surface).toBe(false);
    // Spreading it (exactly what preload/main.ts does) adds nothing.
    const api = { auth: {}, ...surface };
    expect(Object.keys(api)).toEqual(['auth']);
  });

  it('with --prismical-e2e the surface exposes exactly the probes on their channels', async () => {
    const invoked: Array<{ channel: string; payload?: unknown }> = [];
    const surface = makeE2ESurface([...PROD_ARGV, E2E_ARGV_SWITCH], (channel, payload) => {
      invoked.push({ channel, payload });
      return Promise.resolve('stub');
    });
    expect(surface.e2e).toBeDefined();
    expect(Object.keys(surface.e2e ?? {}).sort()).toEqual([
      'authAuthorizeUrl',
      'authPendingState',
      'recording',
      'sessionProbe',
      'streamStats',
    ]);
    await surface.e2e?.streamStats();
    await surface.e2e?.authPendingState();
    await surface.e2e?.authAuthorizeUrl();
    await surface.e2e?.sessionProbe();
    // The recording driver forwards its command payload on e2e:recording.
    await surface.e2e?.recording({ kind: 'forceStart', result: { ok: false, reason: 'permission-denied' } });
    expect(invoked).toEqual([
      { channel: 'e2e:streamStats', payload: undefined },
      { channel: 'e2e:authPendingState', payload: undefined },
      { channel: 'e2e:authAuthorizeUrl', payload: undefined },
      { channel: 'e2e:sessionProbe', payload: undefined },
      {
        channel: 'e2e:recording',
        payload: { kind: 'forceStart', result: { ok: false, reason: 'permission-denied' } },
      },
    ]);
  });
});
