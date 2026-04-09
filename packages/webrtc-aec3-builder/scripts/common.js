const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const audioCaptureRoot = path.join(repoRoot, "packages", "native-helpers", "audio-capture");
const revisionConfig = require(path.join(packageRoot, "config", "webrtc-revision.json"));

const localRoot = path.join(packageRoot, ".local");
const depotToolsDir = path.join(localRoot, "depot_tools");
const checkoutRoot = path.join(localRoot, "webrtc");
const checkoutSrcDir = path.join(checkoutRoot, "src");
const buildOutputRoot = path.join(packageRoot, "build");

const helperHeaderPath = path.join(
  audioCaptureRoot,
  "Sources",
  "PrismicalAec3Bridge",
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
const vendorBundleRoot = path.join(audioCaptureRoot, "Vendor", "WebRTC", "macOS");

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
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    fail(stderr || `Command failed: ${command} ${args.join(" ")}`);
  }

  return (result.stdout || "").trim();
}

function buildEnv(extra = {}) {
  return {
    ...process.env,
    PATH: `${depotToolsDir}:${process.env.PATH || ""}`,
    DEPOT_TOOLS_UPDATE: "0",
    ...extra,
  };
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

function getOutDir(arch) {
  return path.join(checkoutSrcDir, "out", `prismical-mac-${archLabel(arch)}`);
}

function getRelativeOutDir(arch) {
  return path.relative(checkoutSrcDir, getOutDir(arch));
}

function getBuiltArchivePath(arch) {
  return path.join(getOutDir(arch), "obj", "prismical", "libprismical_webrtc_aec3.a");
}

function getStagedArchivePath(arch) {
  return path.join(buildOutputRoot, archLabel(arch), "libprismical_webrtc_aec3.a");
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
    const targetBlock = `    if (rtc_include_tests) {
      deps += [ ":test_suites" ]
    }`;
    const replacementBlock = `${targetBlock}
    deps += [ "//prismical:prismical_webrtc_aec3" ]`;

    if (!rootBuildContents.includes(targetBlock)) {
      fail(`Unable to patch ${rootBuildGnPath} with Prismical GN target dependency.`);
    }

    fs.writeFileSync(
      rootBuildGnPath,
      rootBuildContents.replace(targetBlock, replacementBlock),
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
  repoRoot,
  run,
  syncOverlay,
  vendorBundleRoot,
};
