#!/usr/bin/env node
/**
 * Applies local patches to the whisper.cpp submodule before building.
 *
 * Patches live in ../patches/ and are applied with `git apply` inside the
 * whisper.cpp directory. Already-applied patches are skipped (idempotent).
 */
const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const WHISPER_CPP_DIR = path.join(__dirname, "..", "whisper.cpp");
const PATCHES_DIR = path.join(__dirname, "..", "patches");

// The whisper.cpp submodule may be UNINITIALIZED (git leaves an empty dir for
// the gitlink on clone/checkout), and this script runs as `preinstall` on every
// root `pnpm install` across the whole workspace.
// Guard on the actual sources, not the directory: an empty dir must exit
// cleanly, or a plain checkout breaks `pnpm install` repo-wide. Desktop devs
// initialize the submodule via `dev:prepare`.
const REQUIRED_SOURCES = [
  "CMakeLists.txt",
  "src/whisper.cpp",
  "examples/common-whisper.cpp",
];
if (
  !REQUIRED_SOURCES.every((f) => fs.existsSync(path.join(WHISPER_CPP_DIR, f)))
) {
  process.exit(0);
}

if (!fs.existsSync(PATCHES_DIR)) {
  process.exit(0);
}

const patches = fs
  .readdirSync(PATCHES_DIR)
  .filter((f) => f.endsWith(".patch"))
  .sort();

if (patches.length === 0) {
  process.exit(0);
}

for (const patch of patches) {
  const patchPath = path.join(PATCHES_DIR, patch);

  // Check if already applied
  try {
    execSync(`git apply --check --reverse "${patchPath}"`, {
      cwd: WHISPER_CPP_DIR,
      stdio: "pipe",
    });
    console.log(`[apply-patches] ${patch} — already applied, skipping`);
    continue;
  } catch {
    // Not yet applied — fall through
  }

  // Apply the patch
  try {
    execSync(`git apply "${patchPath}"`, {
      cwd: WHISPER_CPP_DIR,
      stdio: "pipe",
    });
    console.log(`[apply-patches] ${patch} — applied`);
  } catch (e) {
    console.error(`[apply-patches] ${patch} — FAILED: ${e.message}`);
    process.exit(1);
  }
}
