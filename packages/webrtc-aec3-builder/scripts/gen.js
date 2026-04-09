const {
  buildEnv,
  ensureDir,
  getOutDir,
  getRelativeOutDir,
  gnTargetCpu,
  parseArch,
  run,
  syncOverlay,
  checkoutSrcDir,
} = require("./common");

const arch = parseArch(process.argv);

syncOverlay();
ensureDir(getOutDir(arch));

const gnArgs = [
  'target_os="mac"',
  `target_cpu="${gnTargetCpu(arch)}"`,
  "is_debug=false",
  "is_component_build=false",
  "rtc_build_examples=false",
  "rtc_build_tools=false",
  "rtc_include_tests=false",
  "symbol_level=0",
  "enable_dsyms=false",
  "use_custom_libcxx=false",
  'mac_deployment_target="13.0"',
  "treat_warnings_as_errors=false",
];

run(
  "gn",
  ["gen", getRelativeOutDir(arch), `--args=${gnArgs.join(" ")}`],
  {
    cwd: checkoutSrcDir,
    env: buildEnv(),
  },
);
