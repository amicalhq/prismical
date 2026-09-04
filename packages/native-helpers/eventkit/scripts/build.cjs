const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.join(__dirname, '..');
const command = process.argv[2] ?? 'build';

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function clean() {
  for (const target of ['.build', 'bin', '.turbo']) {
    fs.rmSync(path.join(packageRoot, target), { recursive: true, force: true });
  }
}

function build(configuration) {
  if (process.platform !== 'darwin') {
    // macOS-only helper: a no-op (not an error) so turbo builds of the
    // desktop dependency graph succeed on Windows/Linux runners.
    console.log('[eventkit-helper] non-macOS platform — nothing to build');
    return;
  }
  const mode = configuration.toLowerCase();
  run('swift', ['build', '--configuration', mode]);
  const outputDir = path.join(packageRoot, 'bin');
  const target = path.join(outputDir, 'prismical-eventkit');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, '.build', mode, 'prismical-eventkit'), target);
  // Ad-hoc signing makes local TCC attribution deterministic. Forge replaces
  // this with the app's Developer ID signature for release packages.
  run('codesign', ['--force', '--sign', '-', target]);
}

switch (command) {
  case 'build':
    build('Release');
    break;
  case 'dev':
    build('Debug');
    break;
  case 'clean':
    clean();
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}
