const path = require("node:path");
const {
  buildEnv,
  checkoutRoot,
  checkoutSrcDir,
  depotToolsDir,
  ensureDir,
  exists,
  getRepositoryUrl,
  getRevision,
  localRoot,
  log,
  run,
} = require("./common");

function ensureDepotTools() {
  if (exists(depotToolsDir)) {
    log(`Using existing depot_tools at ${depotToolsDir}`);
    return;
  }

  ensureDir(localRoot);
  run("git", ["clone", "https://chromium.googlesource.com/chromium/tools/depot_tools.git", depotToolsDir]);
}

function ensureCheckout() {
  if (exists(checkoutSrcDir)) {
    log(`Using existing WebRTC checkout at ${checkoutSrcDir}`);
    return;
  }

  ensureDir(checkoutRoot);
  run("fetch", ["--nohooks", "webrtc"], {
    cwd: checkoutRoot,
    env: buildEnv(),
  });
}

function syncCheckout() {
  const revision = getRevision();
  const repositoryUrl = getRepositoryUrl();

  run("git", ["remote", "set-url", "origin", repositoryUrl], { cwd: checkoutSrcDir });
  run("git", ["fetch", "origin"], { cwd: checkoutSrcDir });
  run("git", ["checkout", revision], { cwd: checkoutSrcDir });
  run("gclient", ["sync", "-D", "--revision", `src@${revision}`], {
    cwd: checkoutRoot,
    env: buildEnv(),
  });
}

const syncOnly = process.argv.includes("--sync-only");

ensureDepotTools();
if (!syncOnly) {
  ensureCheckout();
}
if (!exists(checkoutSrcDir)) {
  throw new Error(`Checkout missing at ${path.join(checkoutRoot, "src")}. Run fetch first.`);
}
syncCheckout();
