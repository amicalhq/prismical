#!/usr/bin/env node
/**
 * Prepares the whisper.cpp submodule for native addon builds.
 *
 * This intentionally only initializes the submodule when required source files
 * are missing. If the submodule is already present, we leave its checked-out
 * state alone so local work inside the submodule is not reset.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const pkgDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pkgDir, "..", "..");
const submoduleRelativePath = "packages/whisper-wrapper/whisper.cpp";
const whisperDir = path.join(repoRoot, submoduleRelativePath);

const requiredFiles = [
  "CMakeLists.txt",
  "src/whisper.cpp",
  "examples/common-whisper.cpp",
];

function hasRequiredSources() {
  return requiredFiles.every((file) => fs.existsSync(path.join(whisperDir, file)));
}

function run(command, args, options = {}) {
  console.log(`[whisper-wrapper:prepare] ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });
}

if (!hasRequiredSources()) {
  run("git", [
    "submodule",
    "update",
    "--init",
    "--recursive",
    submoduleRelativePath,
  ]);
}

if (!hasRequiredSources()) {
  console.error(
    `[whisper-wrapper:prepare] whisper.cpp sources are missing under ${whisperDir}`,
  );
  process.exit(1);
}

run("node", [path.join(pkgDir, "scripts", "apply-patches.js")], {
  cwd: pkgDir,
});
