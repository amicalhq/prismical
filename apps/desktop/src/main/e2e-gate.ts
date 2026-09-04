/**
 * Build-time gate for the PRISMICAL_E2E* env family.
 *
 * A production PACKAGED binary must ignore PRISMICAL_E2E entirely: honoring it
 * from env alone would swap SecureStore to the plaintext-equivalent e2e codec,
 * register the e2e IPC channels, and redirect logs/userData into an
 * env-chosen directory. The e2e harness drives two targets and BOTH must keep
 * honoring the env:
 *   - bundle: production bundles run via the electron binary (unpackaged);
 *   - packaged: a package built with PRISMICAL_E2E_PACKAGE=1 — the same env
 *     that flips the inspector fuse in forge.config.ts also bakes
 *     __PRISMICAL_E2E_BUILD__=true into the main bundle (vite define,
 *     vite.main.config.mts).
 * Rule: the env family is trusted iff (!isPackaged || baked).
 *
 * entry.ts applies the gate ONCE, before anything else evaluates, by scrubbing
 * the whole family out of process.env when untrusted — every consumer
 * (config.isE2E, logger.ts's resolvePathFn seam, entry's userData setPath,
 * PRISMICAL_E2E_BREAK_BOOT, the protocol-registration skip) reads post-scrub
 * env, so consumers added later are covered by construction. makeAppConfig
 * ALSO applies the pure gate directly (belt and braces for the
 * custody-critical isE2E flag).
 *
 * Electron-free on purpose: logger.ts's module graph and plain-node unit
 * tests import this file outside Electron.
 */

/** The whole env family the gate governs; scrubbed together. */
export const E2E_ENV_VARS = [
  'PRISMICAL_E2E',
  'PRISMICAL_E2E_USER_DATA_DIR',
  'PRISMICAL_E2E_BREAK_BOOT',
  'PRISMICAL_E2E_FAKE_SECURE_STORE',
  'PRISMICAL_E2E_FAKE_AI',
] as const;

export interface E2EGateInput {
  /** process.env.PRISMICAL_E2E === '1' */
  readonly envFlag: boolean;
  /** app.isPackaged */
  readonly isPackaged: boolean;
  /** __PRISMICAL_E2E_BUILD__ — see bakedE2EBuild(). */
  readonly baked: boolean;
}

/** May this binary trust the PRISMICAL_E2E* env family at all? */
export const e2eEnvTrusted = (input: Pick<E2EGateInput, 'isPackaged' | 'baked'>): boolean =>
  !input.isPackaged || input.baked;

/** Is E2E mode active? (config.isE2E — the fan-out point for every e2e seam.) */
export const isE2EActive = (input: E2EGateInput): boolean =>
  input.envFlag && e2eEnvTrusted(input);

/**
 * Local packaged smoke builds need real windows, OAuth browser launch, and OS
 * protocol registration, so they cannot enable the all-or-nothing isE2E flag.
 * They may still opt into the deterministic test codec when (and only when)
 * the binary was explicitly baked as an E2E package. Production packages bake
 * `false`, so a runtime environment variable cannot weaken token custody.
 */
export const shouldUseE2EFakeSecureStore = (input: {
  readonly isE2E: boolean;
  readonly envFlag: boolean;
  readonly baked: boolean;
}): boolean => input.isE2E || (input.envFlag && input.baked);

/**
 * True only in bundles built with PRISMICAL_E2E_PACKAGE=1 (vite define). The
 * define is absent under vitest/tsc — the typeof guard reads that as false,
 * which is safe: those runs are never packaged, so the !isPackaged arm rules.
 */
export const bakedE2EBuild = (): boolean =>
  typeof __PRISMICAL_E2E_BUILD__ !== 'undefined' && __PRISMICAL_E2E_BUILD__ === true;

/** Deletes the env family from the given env record (entry.ts, pre-everything). */
export const scrubE2EEnv = (env: Record<string, string | undefined>): void => {
  for (const key of E2E_ENV_VARS) {
    delete env[key];
  }
};
