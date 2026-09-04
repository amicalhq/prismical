const fs = require("node:fs");
const path = require("node:path");
const {
  buildEnv,
  capture,
  checkoutSrcDir,
  copyFile,
  ensureDir,
  exists,
  getOutDir,
  getVendorBundleRoot,
  getRevision,
  getStagedArchivePath,
  getWindowsStagedDllPath,
  getWindowsStagedImportLibPath,
  helperHeaderPath,
  log,
  parseArch,
  parsePlatform,
  run,
} = require("./common");

const LICENSE_TARGET = "//prismical:prismical_webrtc_aec3";
const webrtcVendorRoot = path.dirname(getVendorBundleRoot("macos"));
const platform = parsePlatform(process.argv);

if (platform === "windows") {
  bundleWindows();
} else {
  bundleMacos();
}

function bundleMacos() {
  const vendorBundleRoot = getVendorBundleRoot("macos");
  const arm64Archive = getStagedArchivePath("arm64");
  const x64Archive = getStagedArchivePath("x64");

  if (!exists(arm64Archive) || !exists(x64Archive)) {
    throw new Error(
      `Missing built archives. Expected:\n- ${arm64Archive}\n- ${x64Archive}`,
    );
  }

  bundleLicenses(vendorBundleRoot, [
    getOutDir("arm64", "macos"),
    getOutDir("x64", "macos"),
  ]);

  const libDir = path.join(vendorBundleRoot, "lib");
  const includeDir = path.join(vendorBundleRoot, "include");
  ensureDir(libDir);
  ensureDir(includeDir);

  const outputArchive = path.join(libDir, "libprismical_webrtc_aec3.a");

  run("lipo", ["-create", arm64Archive, x64Archive, "-output", outputArchive]);
  copyFile(helperHeaderPath, path.join(includeDir, "prismical_aec3.h"));

  const buildInfo = [
    `platform=macos`,
    `revision=${getRevision()}`,
    `generated_at=${new Date().toISOString()}`,
    `arm64_archive=${arm64Archive}`,
    `x64_archive=${x64Archive}`,
  ].join("\n");

  fs.writeFileSync(
    path.join(vendorBundleRoot, "BUILD_INFO.txt"),
    `${buildInfo}\n`,
  );

  log(capture("lipo", ["-info", outputArchive]));
}

function bundleWindows() {
  const arch = parseArch(process.argv);
  const vendorBundleRoot = getVendorBundleRoot("windows");
  const stagedDllPath = getWindowsStagedDllPath(arch);
  const stagedImportLibPath = getWindowsStagedImportLibPath(arch);
  if (!exists(stagedDllPath)) {
    throw new Error(`Missing built Windows DLL. Expected: ${stagedDllPath}`);
  }

  bundleLicenses(path.join(vendorBundleRoot, arch), [
    getOutDir(arch, "windows"),
  ]);

  const binDir = path.join(vendorBundleRoot, arch, "bin");
  const libDir = path.join(vendorBundleRoot, arch, "lib");
  const includeDir = path.join(vendorBundleRoot, "include");
  ensureDir(binDir);
  ensureDir(libDir);
  ensureDir(includeDir);

  const outputDll = path.join(binDir, "prismical_webrtc_aec3.dll");
  copyFile(stagedDllPath, outputDll);
  copyFile(helperHeaderPath, path.join(includeDir, "prismical_aec3.h"));

  if (exists(stagedImportLibPath)) {
    copyFile(
      stagedImportLibPath,
      path.join(libDir, "prismical_webrtc_aec3.lib"),
    );
  }

  const buildInfo = [
    `platform=windows`,
    `arch=${arch}`,
    `revision=${getRevision()}`,
    `generated_at=${new Date().toISOString()}`,
    `dll=${stagedDllPath}`,
    exists(stagedImportLibPath) ? `import_lib=${stagedImportLibPath}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  fs.writeFileSync(
    path.join(vendorBundleRoot, arch, "BUILD_INFO.txt"),
    `${buildInfo}\n`,
  );
  log(`Windows AEC3 DLL written to ${outputDll}`);
}

function bundleLicenses(vendorBundleRoot, buildfileDirs) {
  const licenseSource = path.join(checkoutSrcDir, "LICENSE");
  const generatorPath = path.join(
    checkoutSrcDir,
    "tools_webrtc",
    "libs",
    "generate_licenses.py",
  );

  for (const requiredPath of [licenseSource, generatorPath, ...buildfileDirs]) {
    if (!exists(requiredPath)) {
      throw new Error(`Cannot bundle WebRTC licenses; missing ${requiredPath}`);
    }
  }

  ensureDir(vendorBundleRoot);
  run(
    "vpython3",
    [
      generatorPath,
      "--target",
      LICENSE_TARGET,
      vendorBundleRoot,
      ...buildfileDirs,
    ],
    {
      cwd: checkoutSrcDir,
      env: buildEnv(),
    },
  );

  const generatedLicensePath = path.join(vendorBundleRoot, "LICENSE.md");
  // The upstream file includes WebRTC's own license. Keep it verbatim while
  // also retaining the root LICENSE beside the platform bundles.
  copyFile(
    generatedLicensePath,
    path.join(vendorBundleRoot, "THIRD_PARTY_LICENSES.md"),
  );
  fs.rmSync(generatedLicensePath);
  copyFile(licenseSource, path.join(webrtcVendorRoot, "LICENSE"));
}
