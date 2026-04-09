const { capture, depotToolsDir, exists, getRepositoryUrl, getRevision, helperHeaderPath, localRoot, log } = require("./common");

const checks = [
  {
    name: "git",
    run: () => capture("git", ["--version"]),
  },
  {
    name: "python3",
    run: () => capture("python3", ["--version"]),
  },
  {
    name: "xcode-select",
    run: () => capture("xcode-select", ["-p"]),
  },
  {
    name: "clang++",
    run: () => capture("clang++", ["--version"]).split("\n")[0],
  },
];

for (const check of checks) {
  const result = check.run();
  log(`${check.name}: ${result}`);
}

log(`repository: ${getRepositoryUrl()}`);
log(`revision: ${getRevision()}`);
log(`local state root: ${localRoot}`);
log(`bridge header: ${helperHeaderPath}`);
log(`depot_tools present: ${exists(depotToolsDir) ? "yes" : "no"}`);
