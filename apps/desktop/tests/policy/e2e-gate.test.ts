/**
 * Packaged-E2E gating: the pure decision behind "may this binary
 * honor the PRISMICAL_E2E* env family?" — trusted iff (!isPackaged || baked),
 * where `baked` is the __PRISMICAL_E2E_BUILD__ vite define that only
 * PRISMICAL_E2E_PACKAGE=1 builds carry. Full truth table, plus the env scrub
 * entry.ts applies and the safe define read under plain node (no define).
 */
import { describe, expect, it } from 'vitest';
import {
  bakedE2EBuild,
  e2eEnvTrusted,
  isE2EActive,
  shouldUseE2EFakeSecureStore,
  scrubE2EEnv,
  E2E_ENV_VARS,
} from '../../src/main/e2e-gate';

describe('e2e gate (pure)', () => {
  it('isE2EActive: full {envFlag, isPackaged, baked} truth table', () => {
    const table: Array<[boolean, boolean, boolean, boolean]> = [
      // envFlag, isPackaged, baked → active
      [false, false, false, false], // dev, no flag
      [false, false, true, false],
      [false, true, false, false], // production package, no flag
      [false, true, true, false], // e2e package, no flag
      [true, false, false, true], // dev / bundle target: env honored
      [true, false, true, true], // unpackaged baked build (bundle via e2e:fresh)
      [true, true, false, false], // PRODUCTION package + env ⇒ IGNORED
      [true, true, true, true], // packaged e2e target: baked ⇒ honored
    ];
    for (const [envFlag, isPackaged, baked, expected] of table) {
      expect(isE2EActive({ envFlag, isPackaged, baked }), `env=${envFlag} pkg=${isPackaged} baked=${baked}`).toBe(expected);
    }
  });

  it('e2eEnvTrusted: only an unbaked PACKAGED binary distrusts the env family', () => {
    expect(e2eEnvTrusted({ isPackaged: false, baked: false })).toBe(true);
    expect(e2eEnvTrusted({ isPackaged: false, baked: true })).toBe(true);
    expect(e2eEnvTrusted({ isPackaged: true, baked: true })).toBe(true);
    expect(e2eEnvTrusted({ isPackaged: true, baked: false })).toBe(false);
  });

  it('fake secure store requires either full E2E mode or an E2E-baked package', () => {
    expect(
      shouldUseE2EFakeSecureStore({ isE2E: false, envFlag: true, baked: false })
    ).toBe(false);
    expect(
      shouldUseE2EFakeSecureStore({ isE2E: false, envFlag: true, baked: true })
    ).toBe(true);
    expect(
      shouldUseE2EFakeSecureStore({ isE2E: true, envFlag: false, baked: false })
    ).toBe(true);
  });

  it('scrubE2EEnv removes the WHOLE family and nothing else', () => {
    const env: Record<string, string | undefined> = {
      PRISMICAL_E2E: '1',
      PRISMICAL_E2E_USER_DATA_DIR: '/tmp/evil-profile',
      PRISMICAL_E2E_BREAK_BOOT: '1',
      PRISMICAL_E2E_FAKE_SECURE_STORE: '1',
      PRISMICAL_CORE_API_URL: 'https://core.prismical.ai',
      PATH: '/usr/bin',
    };
    scrubE2EEnv(env);
    for (const key of E2E_ENV_VARS) {
      expect(key in env, key).toBe(false);
    }
    expect(env.PRISMICAL_CORE_API_URL).toBe('https://core.prismical.ai');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('bakedE2EBuild reads false when the vite define is absent (vitest/plain node)', () => {
    // No define in this process — the typeof guard must not throw and must
    // deny, so unpackaged runs fall through to the !isPackaged arm.
    expect(bakedE2EBuild()).toBe(false);
  });
});
