/**
 * AppConfig auth block. Every auth endpoint derives from
 * endpoints.coreApiUrl so the existing PRISMICAL_CORE_API_URL override
 * retargets all of them at once (the fake-OAuth-server seam for e2e); the
 * client id uses PRISMICAL_CLIENT_ID consistently across build and runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeElectron } from '../helpers/fake-electron';
import { makeAppConfig } from '../../src/main/infra/config/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
const fake = (await import('electron')) as unknown as FakeElectron;

const ENV_KEYS = [
  'PRISMICAL_CORE_API_URL',
  'PRISMICAL_NOTE_WS_URL',
  'PRISMICAL_WEB_APP_ORIGIN',
  'PRISMICAL_ANALYTICS_KEY',
  'GLEAP_KEY',
  'PRISMICAL_CLIENT_ID',
  'PRISMICAL_E2E',
  'PRISMICAL_E2E_FAKE_SECURE_STORE',
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fake.app.isPackaged = false;
});

describe('AppConfig auth block', () => {
  it('enables support only with a nonempty client key and generates a fresh nonce', () => {
    expect(makeAppConfig().gleap).toBeNull();
    process.env.GLEAP_KEY = '  ';
    expect(makeAppConfig().gleap).toBeNull();
    process.env.GLEAP_KEY = 'support-test-key';
    const gleap = makeAppConfig().gleap;
    expect(gleap?.key).toBe('support-test-key');
    expect(gleap?.cspNonce).toMatch(/^[A-Za-z0-9+/]{32}$/);
    expect(makeAppConfig().gleap?.cspNonce).not.toBe(gleap?.cspNonce);
  });
  it('derives all auth URLs from the development server origin when unpackaged', () => {
    const config = makeAppConfig();
    expect(config.auth).toEqual({
      oauthClientId: '',
      // Dev uses the portless loopback receiver (deep-link/dev-loopback.ts) —
      // unpackaged Electron cannot reliably win a custom-scheme registration
      // (see config/live.ts readAuth). Packaged builds keep prismical://.
      // The suite keeps the loopback and packaged custom-scheme behavior distinct.
      redirectUri: 'https://prismical-desktop.localhost/oauth/callback',
      authorizeUrl: 'https://prismical-core.localhost/api/auth/oauth2/authorize',
      tokenUrl: 'https://prismical-core.localhost/api/auth/oauth2/token',
      revokeUrl: 'https://prismical-core.localhost/api/auth/oauth2/revoke',
      jwksUrl: 'https://prismical-core.localhost/api/auth/jwks',
      issuer: 'https://prismical-core.localhost/api/auth',
    });
  });

  it('packaged builds use the production server origin and custom-scheme redirect', () => {
    fake.app.isPackaged = true;
    const config = makeAppConfig();
    expect(config.auth.redirectUri).toBe('prismical://oauth/callback');
    expect(config.auth.authorizeUrl).toBe('https://core.prismical.ai/api/auth/oauth2/authorize');
    expect(config.auth.tokenUrl).toBe('https://core.prismical.ai/api/auth/oauth2/token');
  });

  it('PRISMICAL_CORE_API_URL retargets the server and every auth endpoint', () => {
    process.env.PRISMICAL_CORE_API_URL = 'http://127.0.0.1:43210';
    const config = makeAppConfig();
    expect(config.endpoints.coreApiUrl).toBe('http://127.0.0.1:43210');
    expect(config.auth.authorizeUrl).toBe('http://127.0.0.1:43210/api/auth/oauth2/authorize');
    expect(config.auth.tokenUrl).toBe('http://127.0.0.1:43210/api/auth/oauth2/token');
    expect(config.auth.revokeUrl).toBe('http://127.0.0.1:43210/api/auth/oauth2/revoke');
    expect(config.auth.jwksUrl).toBe('http://127.0.0.1:43210/api/auth/jwks');
    expect(config.auth.issuer).toBe('http://127.0.0.1:43210/api/auth');
  });

  it('PRISMICAL_CLIENT_ID feeds oauthClientId; absence never crashes boot', () => {
    process.env.PRISMICAL_CLIENT_ID = 'desktop-client-123';
    expect(makeAppConfig().auth.oauthClientId).toBe('desktop-client-123');
    delete process.env.PRISMICAL_CLIENT_ID;
    // Empty placeholder — sign-in fails with a clear tagged error, while boot
    // stays clean.
    expect(makeAppConfig().auth.oauthClientId).toBe('');
  });

  // Packaged-E2E gating: vitest carries no __PRISMICAL_E2E_BUILD__
  // define (baked=false), which is exactly the production-package shape — so
  // this pins the security property end to end through makeAppConfig.
  it('PRISMICAL_E2E=1 is IGNORED by an unbaked packaged build (production)', () => {
    process.env.PRISMICAL_E2E = '1';
    fake.app.isPackaged = true;
    const config = makeAppConfig();
    expect(config.isE2E).toBe(false);
    expect(config.secureStoreMode).toBe('safeStorage');
    // The isE2E fan-outs stay production-shaped too.
    expect(config.updaterEnabled).toBe(true);
    expect(config.operationalDbPath).toContain('operational.db');
  });

  it('PRISMICAL_E2E=1 is honored when unpackaged (dev / bundle e2e target)', () => {
    process.env.PRISMICAL_E2E = '1';
    expect(makeAppConfig().isE2E).toBe(true);
    delete process.env.PRISMICAL_E2E;
    expect(makeAppConfig().isE2E).toBe(false);
  });
});
