const {
  buildEnv,
  copyFile,
  ensureDir,
  exists,
  getBuiltArchivePath,
  getOutDir,
  getRelativeOutDir,
  getStagedArchivePath,
  getWindowsStagedDllPath,
  getWindowsStagedImportLibPath,
  parseArch,
  parsePlatform,
  run,
  checkoutSrcDir,
} = require("./common");
const fs = require("node:fs");
const path = require("node:path");

const arch = parseArch(process.argv);
const platform = parsePlatform(process.argv);
const outDir = getOutDir(arch, platform);

if (!exists(path.join(outDir, "args.gn"))) {
  run(
    "node",
    [path.join(__dirname, "gen.js"), "--platform", platform, "--arch", arch],
    {
      cwd: process.cwd(),
      env: process.env,
    },
  );
}

run(
  "autoninja",
  ["-C", getRelativeOutDir(arch, platform), "prismical_webrtc_aec3"],
  {
    cwd: checkoutSrcDir,
    env: buildEnv(),
  },
);

if (platform === "windows") {
  const builtDllPath = findFirst(outDir, "prismical_webrtc_aec3.dll");
  if (!builtDllPath) {
    throw new Error(`Built Windows DLL not found under ${outDir}`);
  }

  const builtImportLibPath =
    findFirst(outDir, "prismical_webrtc_aec3.lib") ??
    findFirst(outDir, "prismical_webrtc_aec3.dll.lib");
  const stagedDllPath = getWindowsStagedDllPath(arch);
  ensureDir(path.dirname(stagedDllPath));
  copyFile(builtDllPath, stagedDllPath);

  if (builtImportLibPath) {
    copyFile(builtImportLibPath, getWindowsStagedImportLibPath(arch));
  }
} else {
  const builtArchivePath = getBuiltArchivePath(arch);
  const stagedArchivePath = getStagedArchivePath(arch);
  ensureDir(path.dirname(stagedArchivePath));
  copyFile(builtArchivePath, stagedArchivePath);
}

function findFirst(rootDir, fileName) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name === fileName) {
        return entryPath;
      }
    }
  }

  return null;
}
