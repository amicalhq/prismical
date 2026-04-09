const fs = require("node:fs");
const path = require("node:path");
const {
  capture,
  copyFile,
  ensureDir,
  exists,
  getRevision,
  getStagedArchivePath,
  helperHeaderPath,
  log,
  run,
  vendorBundleRoot,
} = require("./common");

const arm64Archive = getStagedArchivePath("arm64");
const x64Archive = getStagedArchivePath("x64");

if (!exists(arm64Archive) || !exists(x64Archive)) {
  throw new Error(
    `Missing built archives. Expected:\n- ${arm64Archive}\n- ${x64Archive}`,
  );
}

const libDir = path.join(vendorBundleRoot, "lib");
const includeDir = path.join(vendorBundleRoot, "include");
ensureDir(libDir);
ensureDir(includeDir);

const outputArchive = path.join(libDir, "libprismical_webrtc_aec3.a");

run("lipo", ["-create", arm64Archive, x64Archive, "-output", outputArchive]);
copyFile(helperHeaderPath, path.join(includeDir, "prismical_aec3.h"));

const buildInfo = [
  `revision=${getRevision()}`,
  `generated_at=${new Date().toISOString()}`,
  `arm64_archive=${arm64Archive}`,
  `x64_archive=${x64Archive}`,
].join("\n");

fs.writeFileSync(path.join(vendorBundleRoot, "BUILD_INFO.txt"), `${buildInfo}\n`);

log(capture("lipo", ["-info", outputArchive]));
