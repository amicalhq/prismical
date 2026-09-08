#!/usr/bin/env node
/**
 * `pnpm dev` / `pnpm start` — launch electron-forge through portless.
 * Portless owns the persistent runner so requested restarts retain the callback route.
 *
 * Cloud-mode development against a self-hosted TLS dev stack (the Prismical
 * monorepo's portless `*.localhost` proxy) needs Node to trust that proxy's CA.
 * Startup also imports the OS trust store. `NODE_EXTRA_CA_CERTS` is honoured
 * when set; otherwise the portless CA is used only if it exists on this machine.
 * Local-mode development (no account, no backend) needs neither.
 */
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = { ...process.env };
if (!env.NODE_EXTRA_CA_CERTS) {
  const portlessCa = path.join(os.homedir(), '.portless', 'ca.pem');
  if (existsSync(portlessCa)) env.NODE_EXTRA_CA_CERTS = portlessCa;
}

const child = spawn(
  'portless',
  ['prismical-desktop', 'node', 'scripts/dev-runner.cjs', ...process.argv.slice(2)],
  {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
);
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
