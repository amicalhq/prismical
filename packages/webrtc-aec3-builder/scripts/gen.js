const {
  buildEnv,
  ensureDir,
  getOutDir,
  getRelativeOutDir,
  gnTargetCpu,
  gnTargetOs,
  parseArch,
  parsePlatform,
  run,
  syncOverlay,
  checkoutSrcDir,
} = require("./common");

const arch = parseArch(process.argv);
const platform = parsePlatform(process.argv);

syncOverlay();
ensureDir(getOutDir(arch, platform));

const gnArgs = [
  `target_os="${gnTargetOs(platform)}"`,
  `target_cpu="${gnTargetCpu(arch)}"`,
  "is_debug=false",
  "is_component_build=false",
  "rtc_build_examples=false",
  "rtc_build_tools=false",
  "rtc_include_tests=false",
  "symbol_level=0",
  "use_custom_libcxx=false",
  "treat_warnings_as_errors=false",
];

if (platform === "macos") {
  gnArgs.push("enable_dsyms=false", 'mac_deployment_target="13.0"');
}

run(
  "gn",
  ["gen", getRelativeOutDir(arch, platform), `--args=${gnArgs.join(" ")}`],
  {
    cwd: checkoutSrcDir,
    env: buildEnv(),
  },
);
