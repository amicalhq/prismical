import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { seedAppMode, type SeededAppMode } from './local-profile';

// At runtime (plain Node) the electron package resolves to the path of the
// electron binary; its types describe the in-app API, hence the cast.
import electronBinary from 'electron';

const desktopRoot = path.resolve(__dirname, '../..');

export type LaunchTarget = 'packaged' | 'bundle';

export interface PrismicalLaunch {
  app: ElectronApplication;
  target: LaunchTarget;
  userDataDir: string;
}

export function resolveTarget(): LaunchTarget {
  const target = process.env.PRISMICAL_E2E_TARGET ?? 'packaged';
  if (target !== 'packaged' && target !== 'bundle') {
    throw new Error(`Unknown PRISMICAL_E2E_TARGET "${target}" — expected "packaged" or "bundle"`);
  }
  return target;
}

export function packagedExecutablePath(): string {
  const dir = path.join(desktopRoot, 'out', `Prismical-${process.platform}-${process.arch}`);
  const executable =
    process.platform === 'darwin'
      ? path.join(dir, 'Prismical.app', 'Contents', 'MacOS', 'Prismical')
      : process.platform === 'win32'
        ? path.join(dir, 'Prismical.exe')
        : path.join(dir, 'Prismical');
  if (!existsSync(executable)) {
    throw new Error(
      `No packaged app at ${executable}. Build one with \`PRISMICAL_E2E_PACKAGE=1 pnpm package\` ` +
        `(or run \`pnpm test:e2e:fresh\`).`
    );
  }
  return executable;
}

function assertBundleBuilt(): void {
  const mainBundle = path.join(desktopRoot, '.vite', 'build', 'entry.js');
  if (!existsSync(mainBundle)) {
    throw new Error(
      `No built bundles at ${mainBundle}. Produce production bundles with ` +
        `\`pnpm package\` (or run \`pnpm test:e2e:fresh\`).`
    );
  }
}

export interface LaunchOptions {
  /**
   * The mode a freshly minted profile is seeded with. A
   * profile with NO `app:mode` row boots into the first-run chooser, so the
   * default keeps every cloud spec on the sign-in gate; pass `null` for the
   * first-run specs. Ignored when PRISMICAL_E2E_USER_DATA_DIR reuses a profile.
   */
  readonly seedMode?: SeededAppMode | null;
}

/**
 * Launch the app under test per PRISMICAL_E2E_TARGET. A launch failure is a
 * launch failure: the temp profile is removed and the error is rethrown —
 * nothing here catches-and-continues (broken-boot.spec.ts depends on that).
 *
 * Passing PRISMICAL_E2E_USER_DATA_DIR in extraEnv reuses that profile instead
 * of minting a fresh one — the auth restart-restore specs relaunch into the
 * profile a previous instance signed into (close the first instance with
 * `keepProfile` so it survives).
 */
export async function launchPrismical(
  extraEnv: Record<string, string> = {},
  options: LaunchOptions = {}
): Promise<PrismicalLaunch> {
  const target = resolveTarget();
  const minted = extraEnv.PRISMICAL_E2E_USER_DATA_DIR === undefined;
  const userDataDir =
    extraEnv.PRISMICAL_E2E_USER_DATA_DIR ??
    (await mkdtemp(path.join(tmpdir(), 'prismical-e2e-')));
  const env = {
    ...process.env,
    // E2E kill-switches: skip OS protocol registration (boot.ts) and any
    // future updater work; isolated profile keys its own single-instance lock.
    PRISMICAL_E2E: '1',
    PRISMICAL_E2E_USER_DATA_DIR: userDataDir,
    // Runtime override — beats any bundled telemetry default.
    TELEMETRY_ENABLED: 'false',
    // Only dedicated support tests explicitly enable the SDK.
    GLEAP_KEY: '',
    ...extraEnv,
  };

  try {
    // Inside the try so a seeding failure still removes the minted dir.
    const seedMode = options.seedMode === undefined ? 'cloud' : options.seedMode;
    if (minted && seedMode !== null) seedAppMode(userDataDir, seedMode);
    if (target === 'packaged') {
      const app = await electron.launch({
        executablePath: packagedExecutablePath(),
        env,
        timeout: 60_000,
      });
      return { app, target, userDataDir };
    }
    assertBundleBuilt();
    const app = await electron.launch({
      executablePath: electronBinary as unknown as string,
      // Pass the app dir (not entry.js) so Electron reads package.json and
      // the app keeps its real name/version.
      args: [desktopRoot],
      env,
      timeout: 60_000,
    });
    return { app, target, userDataDir };
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A window served from localhost means `.vite/build` holds dev bundles from
 * `forge start` (dev-server URL baked in), not production bundles — the
 * renderer can never load. Fail with a message that says how to fix it.
 */
export function assertNotStaleDevBundle(pageUrl: string): void {
  if (/^https?:\/\/localhost/.test(pageUrl)) {
    throw new Error(
      `Window loaded ${pageUrl}: .vite/ holds dev bundles (from \`forge start\`). ` +
        `Rebuild production bundles with \`pnpm package\`.`
    );
  }
}

export async function closePrismical(
  launch: PrismicalLaunch | undefined,
  options: { keepProfile?: boolean } = {}
): Promise<void> {
  if (!launch) return;
  try {
    // close() resolves once the app exits; kill if it wedges on shutdown.
    await Promise.race([
      launch.app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('app.close() timed out')), 15_000)
      ),
    ]);
  } catch {
    launch.app.process().kill();
  }
  // keepProfile: the restart specs relaunch into this dir; the SECOND
  // closePrismical (without the flag) removes it.
  if (options.keepProfile !== true) {
    await rm(launch.userDataDir, { recursive: true, force: true });
  }
}
