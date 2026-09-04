#!/usr/bin/env node
/*
 * build-addon.js
 * --------------------------------------------------
 * Compiles the whisper.cpp Node addon (examples/addon.node) for the current
 * platform/arch with acceleration flags, then places the resulting
 * `whisper.node` binary in native/<target>/.
 *
 * NOTE: This is an initial scaffold. It expects the whisper.cpp sources to be
 * vendored at `./whisper.cpp` (git submodule or manual copy). You can refine
 * the build flags as needed.
 */

const { execFileSync, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function run(cmd, opts = {}) {
  console.log(`[build-addon] ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

const pkgDir = path.resolve(__dirname, "..");
const addonDir = path.join(pkgDir, "addon");
const whisperDir = path.join(pkgDir, "whisper.cpp");

const requiredWhisperFiles = [
  "CMakeLists.txt",
  "src/whisper.cpp",
  "examples/common-whisper.cpp",
];

const hasRequiredWhisperSources =
  fs.existsSync(whisperDir) &&
  requiredWhisperFiles.every((file) =>
    fs.existsSync(path.join(whisperDir, file)),
  );

// `--postinstall` (the package.json postinstall hook): this fires on every root
// `pnpm install`, and many workflows (CI, containers, or development outside
// the desktop app) never initialize the whisper.cpp submodule. Missing sources
// are a clean no-op there; explicit builds still fail loudly.
const isPostinstall = process.argv.includes("--postinstall");

if (!fs.existsSync(addonDir) || !hasRequiredWhisperSources) {
  if (isPostinstall) {
    console.log(
      "[build-addon] whisper.cpp sources not present - skipping native build (run `pnpm --filter @prismical/whisper-wrapper dev:prepare` to set them up).",
    );
    process.exit(0);
  }
  console.error(
    "whisper.cpp sources not found. Run `pnpm --filter @prismical/whisper-wrapper dev:prepare` before building.",
  );
  process.exit(1);
}

// WHISPER_BUILD_OUT_DIR lets CI place the cmake build tree on a short Windows
// path so vulkan-shaders-gen's sub-cmake TryCompile doesn't hit MAX_PATH (260).
const buildDir = process.env.WHISPER_BUILD_OUT_DIR
  ? path.resolve(process.env.WHISPER_BUILD_OUT_DIR)
  : path.join(pkgDir, "build");
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

const cacheDir = path.join(pkgDir, ".cmake-js");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

const homeDir = path.join(pkgDir, ".home");
if (!fs.existsSync(homeDir)) fs.mkdirSync(homeDir);

function resolveLibExecutable(env, arch) {
  const archDir = arch === "ia32" ? "x86" : arch === "arm64" ? "arm64" : "x64";
  const hostDirs =
    arch === "ia32"
      ? ["Hostx86", "Hostx64"]
      : arch === "arm64"
        ? ["Hostarm64", "Hostx64"]
        : ["Hostx64"];
  const candidates = [];

  const addIfExists = (candidate) => {
    if (
      candidate &&
      fs.existsSync(candidate) &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  };

  try {
    const whereOutput = execSync("where lib.exe", {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of whereOutput) {
      addIfExists(line);
    }
  } catch (err) {
    // ignore when lib.exe is not on PATH; fall back to manual probing
  }

  const probeVersionedDir = (dir) => {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
      );
    for (const entry of entries) {
      for (const hostDir of hostDirs) {
        const candidate = path.join(
          dir,
          entry,
          "bin",
          hostDir,
          archDir,
          "lib.exe",
        );
        if (fs.existsSync(candidate)) {
          addIfExists(candidate);
          return;
        }
      }
    }
  };

  const probeInstallDir = (installDir) => {
    if (!installDir) return;
    if (fs.existsSync(installDir) && fs.statSync(installDir).isFile()) {
      addIfExists(installDir);
      return;
    }

    for (const hostDir of hostDirs) {
      addIfExists(path.join(installDir, "bin", hostDir, archDir, "lib.exe"));
    }

    const toolsDir = path.join(installDir, "Tools", "MSVC");
    probeVersionedDir(toolsDir);
  };

  const probeVswhere = () => {
    const roots = [
      env["ProgramFiles(x86)"],
      env.ProgramFiles,
      "C:/Program Files (x86)",
      "C:/Program Files",
    ].filter(Boolean);

    for (const root of roots) {
      const vswherePath = path.join(
        root,
        "Microsoft Visual Studio",
        "Installer",
        "vswhere.exe",
      );
      if (!fs.existsSync(vswherePath)) continue;

      try {
        const installPaths = execFileSync(
          vswherePath,
          [
            "-all",
            "-products",
            "*",
            "-version",
            "[17.0,18.0)",
            "-requires",
            arch === "arm64"
              ? "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
              : "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
          ],
          { env, encoding: "utf8" },
        )
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);

        for (const installPath of installPaths) {
          probeInstallDir(path.join(installPath, "VC"));
        }
      } catch (err) {
        // ignore when vswhere is unavailable or no matching VC tools are installed
      }
    }
  };

  probeInstallDir(env.VCToolsInstallDir);
  probeInstallDir(env.VCINSTALLDIR);
  probeInstallDir(env.VSINSTALLDIR && path.join(env.VSINSTALLDIR, "VC"));
  probeVswhere();

  for (const version of ["2022"]) {
    for (const edition of [
      "Enterprise",
      "Community",
      "Professional",
      "BuildTools",
      "Preview",
    ]) {
      probeVersionedDir(
        `C:/Program Files/Microsoft Visual Studio/${version}/${edition}/VC/Tools/MSVC`,
      );
      probeVersionedDir(
        `C:/Program Files (x86)/Microsoft Visual Studio/${version}/${edition}/VC/Tools/MSVC`,
      );
    }
  }

  return candidates[0] || null;
}

function ensureWindowsNodeImportLib(buildVariantDir, arch, env) {
  if (process.platform !== "win32") return;

  const nodeImportLib = path.join(buildVariantDir, "node.lib");
  if (fs.existsSync(nodeImportLib)) return;

  let headersPackageJson;
  try {
    headersPackageJson = require.resolve("node-api-headers/package.json", {
      paths: [pkgDir],
    });
  } catch (err) {
    throw new Error(
      "node-api-headers package not found; cannot generate node.lib on Windows",
    );
  }

  const defPath = path.join(
    path.dirname(headersPackageJson),
    "def",
    "node_api.def",
  );
  if (!fs.existsSync(defPath)) {
    throw new Error(`node_api.def not found at ${defPath}`);
  }

  const machineMap = { x64: "X64", ia32: "X86", arm64: "ARM64" };
  const machine = machineMap[arch] || "X64";

  const libExecutable = resolveLibExecutable(env, arch);
  if (!libExecutable) {
    throw new Error(
      "Unable to locate lib.exe. Ensure the Visual Studio Build Tools are installed and vcvarsall has been applied.",
    );
  }

  console.log(
    `[build-addon] Generating node import library using ${libExecutable} for ${machine} into ${nodeImportLib}`,
  );
  try {
    run(
      `"${libExecutable}" /def:"${defPath}" /machine:${machine} /out:"${nodeImportLib}"`,
      {
        env,
      },
    );
  } catch (error) {
    const message =
      "Failed to generate node import library. Ensure Visual Studio build tools are installed.";
    if (error instanceof Error) {
      error.message = `${message}\n${error.message}`;
      throw error;
    }
    throw new Error(message);
  }
}

function variantFromName(name, platform, arch) {
  const envOverrides = {};
  if (name === "cpu-fallback") {
    return { name, env: envOverrides };
  }

  if (!name.includes("-")) {
    // expand shorthand like "metal" to full name
    name = `${platform}-${arch}-${name}`;
  } else if (!name.startsWith(platform)) {
    console.warn(
      `[build-addon] Warning: variant '${name}' does not match current platform (${platform}), skipping.`,
    );
    return null;
  }

  if (name.includes("-metal")) {
    envOverrides.GGML_METAL = "1";
    envOverrides.GGML_USE_ACCELERATE = "1";
  }
  if (name.includes("-openblas")) {
    envOverrides.GGML_OPENBLAS = "1";
    envOverrides.GGML_BLAS = "1";
  }
  if (name.includes("-cuda")) {
    envOverrides.GGML_CUDA = "1";
  }
  if (name.includes("-vulkan")) {
    envOverrides.GGML_VULKAN = "1";
  }
  if (name.startsWith("darwin-")) {
    envOverrides.GGML_USE_ACCELERATE = envOverrides.GGML_USE_ACCELERATE || "1";
  }

  return { name, env: envOverrides };
}

function computeVariants(platform, arch) {
  const overrides = (process.env.WHISPER_TARGETS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const result = [];

  if (overrides.length > 0) {
    for (const override of overrides) {
      const variant = variantFromName(override, platform, arch);
      if (variant) result.push(variant);
    }
    return result;
  }

  if (platform === "darwin") {
    const metal = variantFromName(`${platform}-${arch}-metal`, platform, arch);
    if (metal) result.push(metal);
  }

  const primary = variantFromName(`${platform}-${arch}`, platform, arch);
  if (primary) result.push(primary);

  return result;
}

// ---------------------------------------------------------------------------
// Postinstall up-to-date check. The postinstall hook fires on EVERY root
// `pnpm install`; a full cmake rebuild there would cost minutes per install
// once the submodule is initialized. A variant is fresh when its recorded
// inputs (whisper.cpp HEAD, the patch set, the GGML flag env) match the stamp.
// Explicit `build:native` runs always rebuild.
function computeBuildStamp(env) {
  let whisperHead = "unknown";
  try {
    whisperHead = execSync("git rev-parse HEAD", {
      cwd: whisperDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // not a git checkout (e.g. a vendored copy) - "unknown" still stamps the
    // patch set and flags, so those changes rebuild; provenance changes won't.
  }
  const sha1File = (file) =>
    require("crypto")
      .createHash("sha1")
      .update(fs.readFileSync(file))
      .digest("hex");
  // The addon sources and this script are build inputs too: without them a
  // stamped skip would silently keep a whisper.node built from OLD addon code.
  const addonInputs = [
    path.join(addonDir, "addon.cpp"),
    path.join(addonDir, "CMakeLists.txt"),
    __filename,
  ]
    .filter((f) => fs.existsSync(f))
    .map((f) => `${path.basename(f)}:${sha1File(f)}`);
  const patchesDir = path.join(pkgDir, "patches");
  const patches = fs.existsSync(patchesDir)
    ? fs
        .readdirSync(patchesDir)
        .filter((f) => f.endsWith(".patch"))
        .sort()
        .map((f) => `${f}:${sha1File(path.join(patchesDir, f))}`)
    : [];
  const flags = [
    "GGML_NATIVE",
    "GGML_METAL",
    "GGML_CUDA",
    "GGML_VULKAN",
    "GGML_OPENBLAS",
    "GGML_BLAS",
    "GGML_USE_ACCELERATE",
  ].map((k) => `${k}=${env[k] ?? ""}`);
  return [whisperHead, ...addonInputs, ...patches, ...flags].join("\n");
}

// Postinstall must never take down an unrelated root `pnpm install` on a
// machine without cmake / VS Build Tools. Warn, keep going; the LOUD paths stay
// loud: explicit build:native rethrows, forge prePackage + CI test:load catch a
// missing binary at packaging time.
function warnPostinstallBuildFailure(variantName, err) {
  console.warn(
    `[build-addon] ${variantName} native build failed during postinstall - continuing without it: ${err.message}`,
  );
  console.warn(
    "[build-addon] run `pnpm --filter @prismical/whisper-wrapper build:native` for full output, or `git submodule deinit -f packages/whisper-wrapper/whisper.cpp` to opt out of local whisper builds.",
  );
}

const { platform, arch } = process;
const variants = computeVariants(platform, arch);

if (variants.length === 0) {
  console.warn(
    "[build-addon] No variants requested, building default cpu-fallback.",
  );
  const fallback = variantFromName("cpu-fallback", platform, arch);
  if (fallback) variants.push(fallback);
}

for (const variant of variants) {
  const buildVariantDir = path.join(
    buildDir,
    variant.name.replace(/[\\/]/g, "_"),
  );
  fs.rmSync(buildVariantDir, { recursive: true, force: true });
  fs.mkdirSync(buildVariantDir, { recursive: true });

  const env = {
    ...process.env,
    GGML_NATIVE:
      typeof process.env.GGML_NATIVE === "string" &&
      process.env.GGML_NATIVE.length > 0
        ? process.env.GGML_NATIVE
        : "OFF",
    CMAKE_JS_CACHE: cacheDir,
    HOME: homeDir,
    CMAKE_JS_NODE_DIR: path.resolve(process.execPath, "..", ".."),
    ...variant.env,
  };

  const targetDir = path.join(pkgDir, "native", variant.name);
  const stampPath = path.join(targetDir, ".build-stamp");
  const stamp = computeBuildStamp(env);
  if (
    isPostinstall &&
    fs.existsSync(path.join(targetDir, "whisper.node")) &&
    fs.existsSync(stampPath) &&
    fs.readFileSync(stampPath, "utf8") === stamp
  ) {
    console.log(
      `[build-addon] ${variant.name} is up to date - skipping (postinstall)`,
    );
    continue;
  }

  console.log(`[build-addon] Building variant ${variant.name}`);

  const cmakeParts = [
    "npx cmake-js compile",
    `-O "${buildVariantDir}"`,
    "-B Release",
    `-d "${addonDir}"`,
    "-T whisper_node",
    "--CD node_runtime=node",
  ];

  if (platform === "win32" && arch === "arm64") {
    cmakeParts.push("--toolset ClangCL");
    // Avoid a runtime dependency on LLVM's libomp.dll, which is available on
    // the build runner but is not part of the packaged desktop application.
    cmakeParts.push("--CDGGML_OPENMP=OFF");
  }

  const propagateCMakeBool = (key) => {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      cmakeParts.push(`--CD${key}=${value}`);
    }
  };

  propagateCMakeBool("GGML_NATIVE");
  propagateCMakeBool("GGML_VULKAN");
  propagateCMakeBool("GGML_METAL");
  propagateCMakeBool("GGML_CUDA");
  propagateCMakeBool("GGML_OPENBLAS");
  propagateCMakeBool("GGML_BLAS");
  propagateCMakeBool("GGML_USE_ACCELERATE");

  try {
    ensureWindowsNodeImportLib(buildVariantDir, arch, env);
    run(cmakeParts.join(" "), {
      cwd: addonDir,
      env,
    });
  } catch (err) {
    if (!isPostinstall) throw err;
    warnPostinstallBuildFailure(variant.name, err);
    continue;
  }

  const builtBinary = path.join(buildVariantDir, "Release", "whisper.node");
  if (!fs.existsSync(builtBinary)) {
    const missing = new Error(
      `Build succeeded but whisper.node not found for variant ${variant.name}`,
    );
    if (isPostinstall) {
      warnPostinstallBuildFailure(variant.name, missing);
      continue;
    }
    throw missing;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(builtBinary, path.join(targetDir, "whisper.node"));
  console.log(`[build-addon] copied to native/${variant.name}/whisper.node`);
  fs.writeFileSync(stampPath, stamp);

  if (platform === "darwin") {
    const targetBinary = path.join(targetDir, "whisper.node");
    try {
      run(`codesign --force --sign - "${targetBinary}"`);
      console.log("[build-addon] codesigned", targetBinary);
    } catch (err) {
      console.warn(
        `[build-addon] warning: codesign failed for ${targetBinary}: ${err.message}`,
      );
    }
  }

  // Remove intermediate build artifacts to keep the package footprint small and avoid
  // extremely long CMake-generated paths that break Windows packaging tools.
  fs.rmSync(buildVariantDir, { recursive: true, force: true });
}
