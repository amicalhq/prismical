const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const audioCaptureRoot = path.join(
  repoRoot,
  "packages",
  "native-helpers",
  "audio-capture",
);
const revisionConfig = require(
  path.join(packageRoot, "config", "webrtc-revision.json"),
);

const localRoot = path.join(packageRoot, ".local");
const depotToolsDir = path.join(localRoot, "depot_tools");
const checkoutRoot = path.join(localRoot, "webrtc");
const checkoutSrcDir = path.join(checkoutRoot, "src");
const buildOutputRoot = path.join(packageRoot, "build");

const helperHeaderPath = path.join(
  audioCaptureRoot,
  "Sources",
  "Aec3Bridge",
  "include",
  "prismical_aec3.h",
);
const helperShimPath = path.join(
  audioCaptureRoot,
  "Vendor",
  "WebRTC",
  "shims",
  "prismical_aec3_vendor.cpp",
);
const overlayBuildGnPath = path.join(packageRoot, "overlay", "BUILD.gn");
const macosVendorBundleRoot = path.join(
  audioCaptureRoot,
  "Vendor",
  "WebRTC",
  "macOS",
);
const windowsVendorBundleRoot = path.join(
  audioCaptureRoot,
  "Vendor",
  "WebRTC",
  "windows",
);

function log(message) {
  console.log(`[webrtc-aec3-builder] ${message}`);
}

function fail(message) {
  console.error(`[webrtc-aec3-builder] ${message}`);
  process.exit(1);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function exists(targetPath) {
  return fs.existsSync(targetPath);
}

function run(command, args, options = {}) {
  const resolvedCommand = resolveCommand(command);
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(resolvedCommand, args, {
    stdio: "inherit",
    shell: shouldRunViaShell(resolvedCommand),
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, args, options = {}) {
  const resolvedCommand = resolveCommand(command);
  const result = spawnSync(resolvedCommand, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: shouldRunViaShell(resolvedCommand),
    ...options,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    fail(stderr || `Command failed: ${command} ${args.join(" ")}`);
  }

  return (result.stdout || "").trim();
}

function buildEnv(extra = {}) {
  const pathEntries = [depotToolsDir];
  if (process.platform === "win32") {
    pathEntries.push(path.join(checkoutSrcDir, "buildtools", "win"));
  }

  return {
    ...process.env,
    PATH: `${pathEntries.join(path.delimiter)}${path.delimiter}${
      process.env.PATH || ""
    }`,
    DEPOT_TOOLS_UPDATE: "0",
    ...(process.platform === "win32"
      ? {
          DEPOT_TOOLS_WIN_TOOLCHAIN:
            process.env.DEPOT_TOOLS_WIN_TOOLCHAIN ?? "0",
        }
      : {}),
    ...extra,
  };
}

function resolveCommand(command) {
  if (process.platform !== "win32" || path.extname(command)) {
    return command;
  }

  if (command === "gn") {
    const gnExecutable = path.join(checkoutSrcDir, "buildtools", "win", "gn.exe");
    if (exists(gnExecutable)) {
      return gnExecutable;
    }
  }

  const depotToolsBatchFile = path.join(depotToolsDir, `${command}.bat`);
  return exists(depotToolsBatchFile) ? depotToolsBatchFile : command;
}

function shouldRunViaShell(command) {
  return process.platform === "win32" && command.toLowerCase().endsWith(".bat");
}

function parsePlatform(argv) {
  const platformFlagIndex = argv.indexOf("--platform");
  if (platformFlagIndex === -1) {
    if (process.platform === "win32") {
      return "windows";
    }
    if (process.platform === "darwin") {
      return "macos";
    }
    fail(
      `Unsupported host platform: ${process.platform}. Use --platform macos|windows.`,
    );
  }

  const platform = argv[platformFlagIndex + 1];
  if (platform !== "macos" && platform !== "windows") {
    fail(`Unsupported platform: ${platform}. Use macos|windows.`);
  }

  return platform;
}

function parseArch(argv) {
  const archFlagIndex = argv.indexOf("--arch");
  if (archFlagIndex === -1 || !argv[archFlagIndex + 1]) {
    fail("Missing required --arch <arm64|x64> argument.");
  }

  const arch = argv[archFlagIndex + 1];
  if (arch !== "arm64" && arch !== "x64") {
    fail(`Unsupported arch: ${arch}`);
  }

  return arch;
}

function archLabel(arch) {
  return arch === "x64" ? "x64" : "arm64";
}

function gnTargetCpu(arch) {
  return arch === "x64" ? "x64" : "arm64";
}

function gnTargetOs(platform) {
  return platform === "windows" ? "win" : "mac";
}

function platformBuildLabel(platform) {
  return platform === "windows" ? "win" : "mac";
}

function getOutDir(arch, platform = "macos") {
  return path.join(
    checkoutSrcDir,
    "out",
    `prismical-${platformBuildLabel(platform)}-${archLabel(arch)}`,
  );
}

function getRelativeOutDir(arch, platform = "macos") {
  return path.relative(checkoutSrcDir, getOutDir(arch, platform));
}

function getBuiltArchivePath(arch) {
  return path.join(
    getOutDir(arch, "macos"),
    "obj",
    "prismical",
    "libprismical_webrtc_aec3.a",
  );
}

function getStagedArchivePath(arch) {
  return path.join(
    buildOutputRoot,
    "macos",
    archLabel(arch),
    "libprismical_webrtc_aec3.a",
  );
}

function getWindowsStagedDllPath(arch) {
  return path.join(
    buildOutputRoot,
    "windows",
    archLabel(arch),
    "prismical_webrtc_aec3.dll",
  );
}

function getWindowsStagedImportLibPath(arch) {
  return path.join(
    buildOutputRoot,
    "windows",
    archLabel(arch),
    "prismical_webrtc_aec3.lib",
  );
}

function getVendorBundleRoot(platform) {
  return platform === "windows"
    ? windowsVendorBundleRoot
    : macosVendorBundleRoot;
}

function copyFile(sourcePath, destinationPath) {
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
}

function syncOverlay() {
  if (!exists(checkoutSrcDir)) {
    fail(`WebRTC checkout missing at ${checkoutSrcDir}. Run fetch first.`);
  }

  const targetDir = path.join(checkoutSrcDir, "prismical");
  const rootBuildGnPath = path.join(checkoutSrcDir, "BUILD.gn");
  const injectionMarker = 'deps += [ "//prismical:prismical_webrtc_aec3" ]';
  ensureDir(targetDir);
  copyFile(overlayBuildGnPath, path.join(targetDir, "BUILD.gn"));
  copyFile(helperHeaderPath, path.join(targetDir, "prismical_aec3.h"));
  copyFile(helperShimPath, path.join(targetDir, "prismical_aec3_vendor.cpp"));

  const rootBuildContents = fs.readFileSync(rootBuildGnPath, "utf8");
  if (!rootBuildContents.includes(injectionMarker)) {
    const targetBlockPattern =
      /    if \(rtc_include_tests\) \{\r?\n      deps \+= \[ ":test_suites" \]\r?\n    \}/;

    if (!targetBlockPattern.test(rootBuildContents)) {
      fail(
        `Unable to patch ${rootBuildGnPath} with Prismical GN target dependency.`,
      );
    }

    fs.writeFileSync(
      rootBuildGnPath,
      rootBuildContents.replace(
        targetBlockPattern,
        `$&\n    deps += [ "//prismical:prismical_webrtc_aec3" ]`,
      ),
    );
  }
}

function getRevision() {
  return revisionConfig.revision;
}

function getRepositoryUrl() {
  return revisionConfig.repositoryUrl;
}

module.exports = {
  archLabel,
  audioCaptureRoot,
  buildEnv,
  buildOutputRoot,
  capture,
  checkoutRoot,
  checkoutSrcDir,
  copyFile,
  depotToolsDir,
  ensureDir,
  exists,
  fail,
  getBuiltArchivePath,
  getOutDir,
  getRelativeOutDir,
  getRepositoryUrl,
  getRevision,
  getStagedArchivePath,
  gnTargetCpu,
  helperHeaderPath,
  localRoot,
  log,
  packageRoot,
  parseArch,
  parsePlatform,
  repoRoot,
  run,
  resolveCommand,
  shouldRunViaShell,
  syncOverlay,
  getVendorBundleRoot,
  getWindowsStagedDllPath,
  getWindowsStagedImportLibPath,
  gnTargetOs,
  macosVendorBundleRoot,
  windowsVendorBundleRoot,
};
