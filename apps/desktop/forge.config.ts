// Auto-load apps/desktop/.env into process.env so
// CODESIGNING_IDENTITY / APPLE_* / SKIP_* are available to the signing config
// below without manual sourcing. Side-effect import — must run before the config.
import 'dotenv/config';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel, type MakerSquirrelConfig } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { downloadNodeBinary, PLATFORMS } from './scripts/download-node-binaries';
import { MACOS_LOCALIZATION_RESOURCES } from './scripts/macos-localization';

// Native helper binaries (built per-host in the prePackage hook, gitignored).
// extraResource drops each at Contents/Resources/<binary> (macOS) or
// resources\<binary> (Windows) — exactly where the runtime resolver looks when
// packaged (process.resourcesPath/<binary>, resolving `.exe` on win32 — see
// infra/audio-capture/audio-capture-binary.ts + infra/mic-detector/
// mic-detector-binary.ts). Dev/start reads the repo bin/ copy instead.
//
// Windows: the same two packages build `.exe` variants via `dotnet publish`
// (their scripts/build.cjs already dispatch by platform), and audio-capture
// links the vendored WebRTC AEC3 DLL (WINDOWS_AEC_DLL). We ship no
// windows-helper / swift-helper for OS integration or shortcuts, so Windows
// has no global hotkeys or recording start/stop sounds.
// ⚠ The whole win32 path is UNTESTED from macOS — it needs a Windows/CI build.
const IS_WINDOWS_BUILD = process.platform === 'win32';
const HELPER_EXE_SUFFIX = IS_WINDOWS_BUILD ? '.exe' : '';

const NATIVE_HELPERS = [
  { package: 'audio-capture', binary: 'audio-capture', platforms: ['darwin', 'win32'] },
  { package: 'mic-detector', binary: 'prismical-mic-detector', platforms: ['darwin', 'win32'] },
  { package: 'eventkit', binary: 'prismical-eventkit', platforms: ['darwin'] },
] as const;

const helperBinaryResource = (helper: (typeof NATIVE_HELPERS)[number]): string =>
  `../../packages/native-helpers/${helper.package}/bin/${helper.binary}${HELPER_EXE_SUFFIX}`;

// Windows-only: the prebuilt WebRTC AEC3 engine that audio-capture.exe links at
// runtime. build.cjs copies it from Vendor/WebRTC/windows/x64/bin into the
// package's bin/ during the win32 build, so it lands in resources/ beside the
// .exe where Windows' DLL search resolves it. (x64 only — no arm64 DLL is
// vendored, so Windows builds target x64.)
const WINDOWS_AEC_DLL = '../../packages/native-helpers/audio-capture/bin/prismical_webrtc_aec3.dll';

const WEBRTC_LICENSE_ROOT = '../../packages/native-helpers/audio-capture/Vendor/WebRTC';
const WEBRTC_LICENSE_RESOURCES =
  process.platform === 'darwin'
    ? [`${WEBRTC_LICENSE_ROOT}/LICENSE`, `${WEBRTC_LICENSE_ROOT}/macOS/THIRD_PARTY_LICENSES.md`]
    : IS_WINDOWS_BUILD
      ? [
          `${WEBRTC_LICENSE_ROOT}/LICENSE`,
          `${WEBRTC_LICENSE_ROOT}/windows/x64/THIRD_PARTY_LICENSES.md`,
        ]
      : [];

// ---------------------------------------------------------------------------
// Unbundleable node_modules.
//
// better-sqlite3 is a native N-API driver — vite externalizes it
// (vite.main.config.mts), so the packaged app must carry it as REAL
// node_modules. These dependencies are copied from the hoisted root
// node_modules via flora-colossus; this repo keeps pnpm's default ISOLATED
// linker (transitive deps live only under .pnpm/), so the prePackage hook
// below resolves each package in the prod closure to its real directory with
// Node's own upward node_modules walk (which pnpm's .pnpm layout is built to
// satisfy) and copies it into apps/desktop/node_modules as REAL dirs — pnpm
// symlinks can't ship (asar hard-errors on out-of-package links, verified).
// Dev-tree tradeoff: the next `pnpm install` restores only the
// DECLARED deps' symlinks; transitive copies persist pnpm-unmanaged until
// manually cleaned — never import one without declaring it, or a fresh clone
// breaks. Repeat packaging always re-copies (resolvePackageDir never treats a
// staged dir as an authoritative source), so bumps can't pin old code.
//
// The packagerConfig then uses an allowlist: `prune: false` +
// an `ignore` callback that ships ONLY /.vite, /package.json and the collected
// node_modules — everything else in the app dir (src, tests, drizzle, e2e…)
// stays out of the asar. Populated by prePackage before the packager walks.
// ---------------------------------------------------------------------------
const EXTERNAL_DEPENDENCIES = ['better-sqlite3', '@prismical/whisper-wrapper'];

let externalModulesToShip: string[] = [];
// prebuilds/<platform>-<arch>.node files the package keeps (see
// stageExternalDependencies + the ignore callback).
let sqlitePrebuildsToShip = new Set<string>();

/**
 * The better-sqlite3 prebuild filenames a forge target needs. forge hands the
 * prePackage hook its raw `arch` argument — a single arch on every supported
 * lane, but `universal`, `all` or a comma list are legal spellings — so expand
 * those instead of failing on a filename that never existed. Linux keeps both
 * the glibc and the musl flavour (lib/binding.js picks at runtime).
 */
const sqlitePrebuildTargets = (platform: string, arch: string): string[] => {
  const arches =
    arch === 'universal' || arch === 'all' ? ['x64', 'arm64'] : arch.split(',').map(a => a.trim());
  return arches.flatMap(a =>
    platform === 'linux' ? [`linux-${a}.node`, `linuxmusl-${a}.node`] : [`${platform}-${a}.node`]
  );
};

const appNodeModules = path.join(__dirname, 'node_modules');
const repoRoot = path.resolve(__dirname, '..', '..');

/** Node's resolution walk (sans exports maps): nearest node_modules/<name> upward. */
const resolvePackageDir = (name: string, fromDir: string): string | null => {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) {
      const real = realpathSync(candidate);
      // A dir previously STAGED into this app's node_modules is NOT an
      // authoritative source: it may be stale, and the staging pass below
      // would rm it before copying it onto itself. Keep looking.
      if (real !== path.join(appNodeModules, name)) return real;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // pnpm's virtual-store fallback dir — the authoritative copy when the
  // walk only found a staged dir (or nothing).
  const fallback = path.join(repoRoot, 'node_modules', '.pnpm', 'node_modules', name);
  return existsSync(path.join(fallback, 'package.json')) ? realpathSync(fallback) : null;
};

/** name → real dir for a package and its prod/optional closure (missing optionals skipped). */
const collectProdClosure = (name: string, fromDir: string, acc: Map<string, string>): void => {
  if (acc.has(name)) return;
  // Type-declaration packages some deps (mis)list under runtime dependencies
  // (e.g. @types/ws → @types/node) — dead weight in an asar.
  if (name.startsWith('@types/')) return;
  // better-sqlite3's only dependency is node-addon-api: C++ headers used when
  // compiling the addon, never required at runtime (the prebuild ships built).
  if (name === 'node-addon-api') return;
  const dir = resolvePackageDir(name, fromDir);
  if (dir === null) return; // uninstalled optionalDependency (other platforms' bindings)
  acc.set(name, dir);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const dep of [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]) {
    collectProdClosure(dep, dir, acc);
  }
};

const stageExternalDependencies = (platform: string, arch: string): void => {
  const closure = new Map<string, string>();
  for (const dep of EXTERNAL_DEPENDENCIES) {
    collectProdClosure(dep, __dirname, closure);
    if (!closure.has(dep)) {
      throw new Error(`[forge] external dependency "${dep}" is not installed`);
    }
  }
  externalModulesToShip = Array.from(closure.keys());
  console.log(
    `[forge] staging ${externalModulesToShip.length} external modules:`,
    externalModulesToShip.join(', ')
  );
  for (const [name, realDir] of closure) {
    const dest = path.join(appNodeModules, name);
    // Always replace whatever sits at dest: pnpm symlinks would ride into the
    // asar as out-of-package links (asar hard-errors on them), and a real dir
    // is a previous staging run's copy that must never be reused — a stale
    // copy would silently ship an old better-sqlite3 prebuild after a version
    // bump. Safe against self-copy because
    // resolvePackageDir never returns a staged dir as the source.
    if (lstatSync(dest, { throwIfNoEntry: false }) !== undefined) {
      rmSync(dest, { recursive: true, force: true });
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(realDir, dest, { recursive: true, dereference: true });
  }

  // Dereference-then-prune: the STAGED whisper-wrapper copy
  // must not carry the whisper.cpp submodule tree or the cmake build caches —
  // hundreds of MB of sources, and CMake-generated paths blow past Windows
  // MAX_PATH during packaging. This prunes only the staged copy under
  // apps/desktop/node_modules; cpSync above already dereferenced, so the real
  // package dir and submodule working tree are never touched.
  // node_modules and .turbo are pruned because the wrapper is a WORKSPACE
  // package here, and dereferencing its dev-dep symlinks (typescript,
  // cmake-js) would copy whole toolchains into the asar. The wrapper's runtime
  // (dist + native) requires none of its declared deps.
  const stagedWhisper = path.join(appNodeModules, '@prismical', 'whisper-wrapper');
  if (existsSync(stagedWhisper)) {
    for (const sub of ['whisper.cpp', 'build', '.cmake-js', '.home', 'node_modules', '.turbo']) {
      rmSync(path.join(stagedWhisper, sub), { recursive: true, force: true });
    }
  }

  // The STAGED better-sqlite3 copy stays a faithful copy of the tarball: it
  // REPLACES pnpm's symlink at apps/desktop/node_modules and outlives packaging
  // (it is what `pnpm dev`/vitest load next), so nothing is deleted here. What
  // the package must NOT carry — the SQLite amalgamation sources (deps/, src/),
  // binding.gyp and every foreign prebuild (~26 MB, and Squirrel's releasify
  // aborts on non-PE .node files) — is excluded by the packager `ignore`
  // callback below, keyed off the prebuilds recorded here for the TARGET
  // (forge's platform/arch, never process.arch) plus the host's own, so a
  // cross-target package still leaves the dev tree loadable.
  const stagedSqlite = path.join(appNodeModules, 'better-sqlite3');
  const shipped = new Set<string>();
  for (const target of sqlitePrebuildTargets(platform, arch)) {
    if (!existsSync(path.join(stagedSqlite, 'prebuilds', target))) {
      throw new Error(`[forge] better-sqlite3 ships no prebuild for ${target}`);
    }
    shipped.add(target);
  }
  shipped.add(`${process.platform}-${process.arch}.node`);
  sqlitePrebuildsToShip = shipped;
};

const config: ForgeConfig = {
  packagerConfig: {
    // The better-sqlite3 native binding (prebuilds/<platform>-<arch>.node)
    // must live on the real filesystem — require() transparently redirects
    // into app.asar.unpacked.
    // The whisper worker goes further: it runs under the bundled Node SIDECAR
    // (not electron), which cannot read asar at all — so the worker bundle and
    // the whole wrapper package (dist + native/*.node) unpack too, and the
    // worker's require() walk finds them under app.asar.unpacked/.
    asar: {
      unpack:
        '{**/*.node,**/*.metal,**/node_modules/@prismical/whisper-wrapper/**,**/.vite/build/whisper-worker-fork.js}',
    },
    appBundleId: 'com.prismical.desktop',
    executableName: 'Prismical',
    // App bundle icon — packager appends .icns (macOS) / .ico (Windows) to this
    // extensionless path (assets/logo.{icns,ico} both exist). Without it the
    // bundle ships Electron's default placeholder icon.
    icon: './assets/logo',
    // Tray template icon and the two native helper
    // binaries. extraResource copies each entry into resources/ preserving its
    // basename, so the helpers land at Contents/Resources/{audio-capture,
    // prismical-mic-detector} (macOS) / resources\{audio-capture.exe,
    // prismical-mic-detector.exe} (Windows). On Windows the vendored WebRTC AEC3
    // DLL rides along beside audio-capture.exe.
    extraResource: [
      './assets',
      ...(process.platform === 'darwin' ? MACOS_LOCALIZATION_RESOURCES : []),
      ...NATIVE_HELPERS.filter(helper =>
        helper.platforms.some(platform => platform === process.platform)
      ).map(helperBinaryResource),
      ...(IS_WINDOWS_BUILD ? [WINDOWS_AEC_DLL] : []),
      ...WEBRTC_LICENSE_RESOURCES,
    ],
    // Microphone / system-audio usage strings. NSMicrophoneUsageDescription
    // is MANDATORY — a mic-access attempt without it hard-crashes the process on
    // macOS. NSAudioCaptureUsageDescription covers the CoreAudio process-tap
    // system-audio path (macOS >= 14.2). Both surface as the TCC prompt copy.
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Prismical records your microphone so it can capture and transcribe your meetings.',
      NSAudioCaptureUsageDescription:
        'Prismical captures system audio so it can transcribe everyone in the meeting, not just you.',
      NSCalendarsUsageDescription:
        'Prismical reads the calendars you choose so it can show upcoming meetings and prepare notes.',
      NSCalendarsFullAccessUsageDescription:
        'Prismical reads the calendars you choose so it can show upcoming meetings and prepare notes.',
    },
    // The released app owns prismical://. prismical-dev:// is dev-only and registered at runtime
    // for unpackaged builds — it never ships in the packaged Info.plist.
    protocols: [
      {
        name: 'Prismical',
        schemes: ['prismical'],
      },
    ],
    // macOS Developer-ID signing + notarization. `.env` is auto-loaded via
    // `dotenv/config` (top of file), so CODESIGNING_IDENTITY + the APPLE_*
    // notarize creds live there. Signing is SKIPPED by default so the cert-less
    // smoke / packaged-e2e / CI builds stay unsigned; set SKIP_CODESIGNING=false to
    // produce a signed build. Signing stays opt-in because the packaged-e2e
    // harness runs `pnpm package` without a certificate.
    //
    // osx-sign's default parent entitlements omit Calendar access. On hardened
    // runtime macOS rejects the EventKit prompt before showing UI unless the
    // responsible app carries com.apple.security.personal-information.calendars.
    // Apply that to the parent and the least-privilege helper that talks to
    // EventKit; every other nested Mach-O keeps osx-sign's platform defaults.
    ...(process.env.SKIP_CODESIGNING === 'false'
      ? {
          osxSign: {
            // @electron/packager otherwise warns and continues when signing
            // fails, leaving an ad-hoc bundle that cannot request EventKit
            // access reliably. A requested signed build must be all-or-nothing.
            continueOnError: false,
            ...(process.env.CODESIGNING_IDENTITY
              ? { identity: process.env.CODESIGNING_IDENTITY }
              : {}),
            optionsForFile: (filePath: string) => {
              if (path.basename(filePath) === 'Prismical.app') {
                return { entitlements: path.join(__dirname, 'entitlements.mac.plist') };
              }
              if (path.basename(filePath) === 'prismical-eventkit') {
                return { entitlements: path.join(__dirname, 'entitlements.eventkit.plist') };
              }
              // The bundled Node sidecar needs JIT entitlements under the
              // hardened runtime or the whisper worker dies on spawn.
              if (filePath.replace(/\\/g, '/').endsWith('/Contents/Resources/node')) {
                return {
                  entitlements: path.join(__dirname, 'entitlements.node.plist'),
                  hardenedRuntime: true,
                };
              }
              return {};
            },
          } as Exclude<NonNullable<ForgeConfig['packagerConfig']>['osxSign'], true | undefined>,
          // Notarize inline during `make` (notarytool + auto-staple) with an
          // Apple ID, app-specific password and team id. Only when all three
          // are present, so a signed-but-unnotarized local build (no creds) still
          // works; CI/release supplies them.
          ...(process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD && process.env.APPLE_TEAM_ID
            ? {
                osxNotarize: {
                  appleId: process.env.APPLE_ID,
                  appleIdPassword: process.env.APPLE_APP_PASSWORD,
                  teamId: process.env.APPLE_TEAM_ID,
                },
              }
            : {}),
        }
      : {}),
    // Ship an allowlist, not a prune: ONLY the built bundles, the app
    // package.json (packager requires it) and the staged external node_modules
    // enter the asar. See the EXTERNAL_DEPENDENCIES block.
    prune: false,
    ignore: (file: string) => {
      if (file === '') return false; // root — must be kept or nothing packages
      const p = file.replace(/\\/g, '/');
      if (
        p === '/package.json' ||
        p === '/node_modules' ||
        p === '/.vite' ||
        p.startsWith('/.vite/')
      ) {
        return false;
      }
      if (p.startsWith('/node_modules/better-sqlite3/')) {
        const rest = p.slice('/node_modules/better-sqlite3/'.length);
        if (rest === 'binding.gyp' || rest === 'deps' || rest.startsWith('deps/')) return true;
        if (rest === 'src' || rest.startsWith('src/')) return true;
        if (rest.startsWith('prebuilds/') && !sqlitePrebuildsToShip.has(rest.slice('prebuilds/'.length))) {
          return true;
        }
      }
      if (p.startsWith('/node_modules/')) {
        for (const dep of externalModulesToShip) {
          if (p === `/node_modules/${dep}` || p.startsWith(`/node_modules/${dep}/`)) return false;
          // Keep the bare @scope dir so the packager's walk descends into it.
          if (dep.startsWith('@') && p === `/node_modules/${dep.split('/')[0]}`) return false;
        }
      }
      return true;
    },
  },
  // better-sqlite3 ships a binding.gyp, and forge's afterCopy rebuild
  // (@electron/rebuild) would node-gyp EVERY prod dep carrying one — needing
  // python, an Electron headers download and MSVC on the Windows runner, and
  // the deps/ sources the ignore callback keeps out of the copy. The in-package N-API
  // prebuild already loads under Electron, so the rebuild skips it.
  rebuildConfig: { ignoreModules: ['better-sqlite3'] },
  // Makers: ZIP + DMG (darwin), Squirrel (win32). The DMG is
  // the macOS install artifact; the ZIP is
  // Squirrel.Mac's UPDATE feed (Electron's built-in autoUpdater downloads the ZIP
  // that core's /update endpoint points at — MANDATORY even though users install
  // the DMG). The release workflow attaches every artifact to GitHub Releases;
  // Core selects the matching published release asset.
  //
  // DMG (#3517 resolved WITHOUT the @fellow fork): the stock
  // `@electron-forge/maker-dmg` builds via appdmg, which needs two native bindings
  // — macos-alias→volume.node and fs-xattr→xattr.node — that pnpm 10 skips
  // building (both ship `gypfile:false` + no install script, so there's no build
  // script to allow). Fix lives in the root pnpm config: those two deps are in
  // `onlyBuiltDependencies`, and a metadata patch (patches/{macos-alias,fs-xattr})
  // adds `install: node-gyp rebuild` so the allowlist has something to run. Both
  // compile cleanly on Node 24; a real DMG was verified from the packaged .app.
  // Branded with the Prismical volume icon + window background (assets/).
  //
  // Windows: MakerSquirrel produces Setup.exe + RELEASES + the .nupkg; setupIcon
  // comes from assets/logo.ico. Squirrel pairs
  // with Electron's built-in autoUpdater against core's /update/.../RELEASES +
  // /update/.../:package.nupkg endpoints backed by GitHub Releases. This uses
  // Squirrel, not NSIS/electron-updater. The renderer + cloud lanes
  // are cross-platform and the recording binaries ARE built for win32 (see the
  // helper header + prePackage), so a Windows build is a full app — MINUS global
  // hotkeys / start-stop sounds. ⚠ UNTESTED from macOS
  // — a Windows/CI runner must build + verify (dotnet publish for the helpers,
  // Squirrel packaging).
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({ icon: './assets/logo.icns', background: './assets/dmg_bg.tiff' }, ['darwin']),
    new MakerSquirrel(
      {
        name: 'Prismical',
        setupIcon: './assets/logo.ico',
        // Squirrel generates the app-launcher stub + Update.exe DURING `make`
        // (releasify), AFTER the packaged-app signing pass — so those stubs can
        // only be signed inside releasify. CI's release.yml sets these env vars
        // (Azure Trusted Signing dlib + signtool); local/PR/
        // unsigned builds leave them unset, so no windowsSign block is added and
        // the Setup.exe ships unsigned. (Traditional .pfx signing would instead
        // set certificateFile/certificatePassword here; this path uses Azure
        // Trusted Signing.)
        ...(process.env.WINDOWS_SIGN_WITH_PARAMS
          ? {
              windowsSign: {
                // Modern SDK signtool — Squirrel's vendored copy predates the
                // /dlib flag Azure Trusted Signing needs.
                signToolPath: process.env.WINDOWS_SIGNTOOL_PATH,
                signWithParams: process.env.WINDOWS_SIGN_WITH_PARAMS,
                timestampServer: 'http://timestamp.acs.microsoft.com',
                // Trusted Signing is SHA-256 only; the default would also attempt
                // a SHA-1 dual-sign pass.
                hashes: ['sha256'],
              } as MakerSquirrelConfig['windowsSign'],
            }
          : {}),
      },
      ['win32']
    ),
  ],
  hooks: {
    // Guarantee the native helper binaries exist before @electron/packager
    // copies them via extraResource. bin/ is gitignored (built per machine), so
    // a fresh checkout / CI would otherwise fail the copy. Build only the missing
    // ones (idempotent, a no-op once a build has run). The helpers' build.cjs
    // dispatches by host platform (Swift on darwin, `dotnet publish` on win32),
    // so this runs on both — Linux (or any other target) is skipped.
    prePackage: async (_forgeConfig, platform, arch) => {
      if (platform !== 'darwin' && platform !== 'win32') return;
      // Local whisper: build the wrapper (tsc dist + native addon) when the
      // whisper.cpp submodule is initialized, so packaging never ships a stale
      // or missing binary (the build-addon `--postinstall` mode is stamp-aware,
      // so a repeat package is a fast no-op). Without the submodule the app
      // still packages — minus local whisper (PR CI takes that path; the
      // release legs check out submodules and smoke-load the addon).
      const whisperPkgDir = path.resolve(repoRoot, 'packages', 'whisper-wrapper');
      if (existsSync(path.join(whisperPkgDir, 'whisper.cpp', 'src', 'whisper.cpp'))) {
        console.log('[forge] ensuring whisper wrapper dist + native binaries');
        execFileSync('pnpm', ['--filter', '@prismical/whisper-wrapper', 'build'], {
          cwd: repoRoot,
          stdio: 'inherit',
          shell: IS_WINDOWS_BUILD,
        });
        execFileSync('node', ['bin/build-addon.js', '--postinstall'], {
          cwd: whisperPkgDir,
          stdio: 'inherit',
        });
      } else {
        console.warn(
          '[forge] whisper.cpp submodule not initialized — packaging WITHOUT local whisper'
        );
      }
      // Stage the unbundleable node_modules (better-sqlite3 + whisper wrapper)
      // + populate the ignore allowlist before the packager walks the app dir.
      stageExternalDependencies(platform, arch);
      const exeSuffix = platform === 'win32' ? '.exe' : '';
      for (const helper of NATIVE_HELPERS.filter(helper =>
        helper.platforms.some(supported => supported === platform)
      )) {
        const packageDir = path.resolve(
          process.cwd(),
          '..',
          '..',
          'packages',
          'native-helpers',
          helper.package
        );
        const binaryPath = path.join(packageDir, 'bin', `${helper.binary}${exeSuffix}`);
        if (existsSync(binaryPath)) continue;
        console.log(
          `[forge] building native helper "${helper.package}" (missing at ${binaryPath})`
        );
        execFileSync('node', ['scripts/build.cjs', 'build'], {
          cwd: packageDir,
          stdio: 'inherit',
        });
        if (!existsSync(binaryPath)) {
          throw new Error(
            `Native helper build for "${helper.package}" did not produce ${binaryPath}.`
          );
        }
      }
    },
    // Bundled Node sidecar: the whisper worker runs
    // out-of-process under a standalone Node binary — forking the electron
    // binary would boot a second app instance, and the worker must survive
    // renderer/main GC pauses. packageAfterCopy drops it at
    // Contents/Resources/node (macOS) / resources\node.exe (Windows), exactly
    // where infra/whisper/engine.ts's resolveWhisperWorkerPaths() resolves when packaged.
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      if (platform !== 'darwin' && platform !== 'win32') return;
      const nodePlatform = PLATFORMS.find(
        candidate => candidate.platform === platform && candidate.arch === arch
      );
      if (!nodePlatform) {
        throw new Error(`Unsupported Node.js sidecar target: ${platform}-${arch}`);
      }
      await downloadNodeBinary(nodePlatform);
      const binaryName = platform === 'win32' ? 'node.exe' : 'node';
      const binarySource = path.join(__dirname, 'node-binaries', `${platform}-${arch}`, binaryName);
      const binaryDestination = path.join(path.dirname(buildPath), binaryName);
      copyFileSync(binarySource, binaryDestination);
      if (platform !== 'win32') {
        chmodSync(binaryDestination, 0o755);
      }
      console.log(`[forge] Node sidecar staged at ${binaryDestination}`);
    },
    // Windows-only: the vendored WebRTC AEC3 DLL (and audio-capture.exe if it
    // links the MSVC runtime dynamically) needs the VC++ runtime DLLs, which
    // aren't guaranteed on target machines. Bundle them from the build host's
    // System32 beside the packaged binaries (Windows resolves DLLs from the
    // loading module's directory first). Non-fatal: this path is unverified, and
    // the AEC DLL may be statically linked (making this unnecessary) — warn
    // rather than fail the build. Requires a Windows build host with VC++ (e.g.
    // GitHub Actions windows-2025). ⚠ UNTESTED.
    postPackage: async (_forgeConfig, options) => {
      if (options.platform !== 'win32') return;
      const vcRuntimeDlls = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
      for (const outputPath of options.outputPaths) {
        const resourcesDir = path.join(outputPath, 'resources');
        for (const dll of vcRuntimeDlls) {
          try {
            copyFileSync(path.join('C:\\Windows\\System32', dll), path.join(resourcesDir, dll));
          } catch (error) {
            console.warn(`[forge] could not bundle VC++ runtime ${dll}: ${String(error)}`);
          }
        }
      }
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/entry.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          // The whisper worker — its OWN single-entry build so the emitted
          // bundle is self-contained: as a second input of the main build,
          // rollup splits the shared protocol module into a chunk that stays
          // inside app.asar, unreadable by the plain-Node sidecar that forks
          // the worker (see vite.worker.config.mts). Target 'main': it is
          // main-process code built with the node/cjs base config.
          entry: 'src/main/infra/whisper/whisper-worker-fork.ts',
          config: 'vite.worker.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload/main.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
        {
          entry: 'src/preload/widget.ts',
          config: 'vite.preload.widget.config.mts',
          target: 'preload',
        },
        {
          entry: 'src/preload/notify.ts',
          config: 'vite.preload.notify.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses burn at package time, before code signing.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // Playwright drives the packaged app through the Node inspector, which
      // this fuse blocks. PRISMICAL_E2E_PACKAGE=1 builds an e2e-testable
      // package; release builds keep it disabled.
      [FuseV1Options.EnableNodeCliInspectArguments]: process.env.PRISMICAL_E2E_PACKAGE === '1',
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
