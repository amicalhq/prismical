const {
  buildEnv,
  copyFile,
  ensureDir,
  exists,
  getBuiltArchivePath,
  getOutDir,
  getRelativeOutDir,
  getStagedArchivePath,
  parseArch,
  run,
  checkoutSrcDir,
} = require("./common");

const arch = parseArch(process.argv);
const outDir = getOutDir(arch);

if (!exists(pathJoin(outDir, "args.gn"))) {
  run("node", [pathJoin(__dirname, "gen.js"), "--arch", arch], {
    cwd: process.cwd(),
    env: process.env,
  });
}

run("autoninja", ["-C", getRelativeOutDir(arch), "prismical_webrtc_aec3"], {
  cwd: checkoutSrcDir,
  env: buildEnv(),
});

const builtArchivePath = getBuiltArchivePath(arch);
const stagedArchivePath = getStagedArchivePath(arch);
ensureDir(pathDirname(stagedArchivePath));
copyFile(builtArchivePath, stagedArchivePath);

function pathJoin(...parts) {
  return require("node:path").join(...parts);
}

function pathDirname(targetPath) {
  return require("node:path").dirname(targetPath);
}
