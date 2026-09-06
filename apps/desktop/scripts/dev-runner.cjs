#!/usr/bin/env node
// Runs inside Portless. Forge may exit on an in-app restart; this process stays
// alive to keep the route and PORT, then recreates Forge and its Vite server.
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

function runDevRunner(command, args) {
  const directory = mkdtempSync(path.join(tmpdir(), 'prismical-dev-restart-'));
  const restartFile = path.join(directory, 'requested');
  const env = { ...process.env, PRISMICAL_DEV_RESTART_FILE: restartFile };
  let child;
  let stopping = false;

  const stop = signal => {
    stopping = true;
    child.kill(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));

  const start = () => {
    child = spawn(command, args, { env, stdio: 'inherit' });
    child.once('error', error => {
      console.error(`Could not start the desktop dev server: ${error.message}`);
      process.exit(1);
    });
    child.once('exit', (code, signal) => {
      if (!stopping && signal === null && code === 0 && existsSync(restartFile)) {
        rmSync(restartFile);
        start();
        return;
      }
      process.exit(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  };
  start();
}

module.exports = { runDevRunner };

if (require.main === module) {
  runDevRunner(process.execPath, [
    require.resolve('@electron-forge/cli/dist/electron-forge.js'),
    'start',
    ...process.argv.slice(2),
  ]);
}
