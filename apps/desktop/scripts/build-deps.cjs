#!/usr/bin/env node
/**
 * Freshness-gated native-helper builds.
 *
 * `build:deps` runs before EVERY dev/start/package/make so a stale helper
 * binary can never ship — but an UNCONDITIONAL rebuild
 * costs a full `swift build` per helper per launch on macOS and two complete
 * `dotnet publish` runs on Windows. This wrapper rebuilds a helper only when
 * its bin/ output is missing or older than the newest source file, keeping
 * both properties: source edits always rebuild, fresh binaries are a ~no-op.
 * `pnpm --filter <helper> build` remains the always-rebuild path.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const HELPERS = [
  { pkg: '@prismical/audio-capture', dir: 'audio-capture', platforms: ['darwin', 'win32'] },
  { pkg: '@prismical/mic-detector', dir: 'mic-detector', platforms: ['darwin', 'win32'] },
  { pkg: '@prismical/eventkit-helper', dir: 'eventkit', platforms: ['darwin'] },
];

/** Build artifacts and caches that must not count as "sources". */
const IGNORED = new Set(['bin', '.build', '.turbo', 'obj', 'node_modules', '.data']);

function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
    } else {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

function oldestBinMtime(binDir) {
  if (!fs.existsSync(binDir)) return null;
  const files = fs.readdirSync(binDir).filter(f => !f.startsWith('.'));
  if (files.length === 0) return null;
  return Math.min(...files.map(f => fs.statSync(path.join(binDir, f)).mtimeMs));
}

for (const helper of HELPERS) {
  if (!helper.platforms.includes(process.platform)) continue;
  const pkgDir = path.join(repoRoot, 'packages', 'native-helpers', helper.dir);
  const binMtime = oldestBinMtime(path.join(pkgDir, 'bin'));
  if (binMtime !== null && newestSourceMtime(pkgDir) <= binMtime) {
    console.log(`[build-deps] ${helper.pkg} is fresh — skipping`);
    continue;
  }
  console.log(`[build-deps] building ${helper.pkg}`);
  execFileSync('pnpm', ['--filter', helper.pkg, 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
