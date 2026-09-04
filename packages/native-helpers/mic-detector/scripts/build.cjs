const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const command = process.argv[2] ?? "build";

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    shell: false,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function clean() {
  for (const target of [
    ".build",
    "bin",
    ".turbo",
    path.join("windows", "bin"),
    path.join("windows", "obj"),
  ]) {
    fs.rmSync(path.join(__dirname, "..", target), {
      recursive: true,
      force: true,
    });
  }
}

function buildDarwin(configuration) {
  run("swift", ["build", "--configuration", configuration.toLowerCase()]);

  const packageRoot = path.join(__dirname, "..");
  const outputDir = path.join(packageRoot, "bin");
  const source = path.join(
    packageRoot,
    ".build",
    configuration.toLowerCase(),
    "prismical-mic-detector",
  );
  const target = path.join(outputDir, "prismical-mic-detector");

  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(source, target);
  run("codesign", ["--force", "--sign", "-", target]);
}

function buildWindows(configuration) {
  const runtime =
    process.arch === "arm64"
      ? "win-arm64"
      : process.arch === "ia32"
        ? "win-x86"
        : "win-x64";

  cleanWindowsBin("prismical-mic-detector");
  cleanWindowsPublishState();

  run("dotnet", [
    "publish",
    path.join("windows", "PrismicalMicDetector.Windows.csproj"),
    "-c",
    configuration,
    "-r",
    runtime,
    "--self-contained",
    "true",
    "-o",
    "bin",
  ]);
}

function cleanWindowsPublishState() {
  fs.rmSync(path.join(__dirname, "..", "windows", "obj"), {
    recursive: true,
    force: true,
  });
}

function cleanWindowsBin(executableName) {
  const outputDir = path.join(__dirname, "..", "bin");
  if (!fs.existsSync(outputDir)) {
    return;
  }

  for (const item of fs.readdirSync(outputDir)) {
    if (
      item === `${executableName}.exe` ||
      item === `${executableName}.pdb` ||
      item.endsWith(".dll")
    ) {
      fs.rmSync(path.join(outputDir, item), { force: true });
    }
  }
}

function build(configuration) {
  if (process.platform === "darwin") {
    buildDarwin(configuration);
    return;
  }

  if (process.platform === "win32") {
    buildWindows(configuration);
    return;
  }

  throw new Error(`Unsupported platform for mic detector: ${process.platform}`);
}

switch (command) {
  case "build":
    build("Release");
    break;
  case "dev":
    build("Debug");
    break;
  case "clean":
    clean();
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}
