const { spawnSync } = require("node:child_process");
const {
  buildEnv,
  depotToolsDir,
  exists,
  getRepositoryUrl,
  getRevision,
  helperHeaderPath,
  localRoot,
  log,
  parsePlatform,
  resolveCommand,
  shouldRunViaShell,
} = require("./common");

const platform = parsePlatform(process.argv);
const checks = [
  {
    name: "git",
    command: "git",
    args: ["--version"],
    required: true,
  },
  {
    name: "python",
    command: process.platform === "win32" ? "python" : "python3",
    args: ["--version"],
    required: true,
  },
  {
    name: "gn",
    command: "gn",
    args: ["--version"],
    required: false,
    env: buildEnv(),
  },
  {
    name: "autoninja",
    command: "autoninja",
    args: ["--version"],
    required: false,
    env: buildEnv(),
  },
];

if (platform === "windows") {
  checks.push({
    name: "cl",
    command: "cl",
    args: [],
    required: false,
  });
} else {
  checks.push(
    {
      name: "xcode-select",
      command: "xcode-select",
      args: ["-p"],
      required: true,
    },
    {
      name: "clang++",
      command: "clang++",
      args: ["--version"],
      required: true,
      firstLineOnly: true,
    },
  );
}

let failedRequiredCheck = false;
for (const check of checks) {
  const result = runCheck(check);
  if (result.ok) {
    log(`${check.name}: ${result.output}`);
    continue;
  }

  const marker = check.required ? "missing" : "not found";
  log(`${check.name}: ${marker} (${result.output})`);
  failedRequiredCheck ||= check.required;
}

log(`platform: ${platform}`);
log(`repository: ${getRepositoryUrl()}`);
log(`revision: ${getRevision()}`);
log(`local state root: ${localRoot}`);
log(`bridge header: ${helperHeaderPath}`);
log(`depot_tools present: ${exists(depotToolsDir) ? "yes" : "no"}`);

if (failedRequiredCheck) {
  process.exit(1);
}

function runCheck(check) {
  const resolvedCommand = resolveCommand(check.command);
  const result = spawnSync(resolvedCommand, check.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: check.env ?? process.env,
    shell: shouldRunViaShell(resolvedCommand),
  });

  const output = (result.stdout || result.stderr || result.error?.message || "")
    .trim()
    .split(/\r?\n/)[0];

  return {
    ok: result.status === 0,
    output,
  };
}
