import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runner = path.resolve('scripts/dev-runner.cjs');
let child: ChildProcess | undefined;
let directory: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  child = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function start() {
  directory = await mkdtemp(path.join(tmpdir(), 'prismical-dev-runner-test-'));
  const fixture = path.join(directory, 'forge.cjs');
  const launches = path.join(directory, 'launches');
  // A separate child process models Forge's lifetime: a requested app restart
  // exits Forge too. Each new process binds the callback port and a fresh UI server.
  await writeFile(
    fixture,
    `
    const http = require('node:http');
    const fs = require('node:fs');
    const ui = http.createServer((req, res) => res.end('renderer'));
    const callback = http.createServer((req, res) => {
      if (req.url === '/restart' || req.url === '/crash') {
        fs.writeFileSync(process.env.PRISMICAL_DEV_RESTART_FILE, '');
      }
      res.setHeader('connection', 'close');
      res.end(JSON.stringify({ pid: process.pid, port: process.env.PORT,
        url: process.env.PORTLESS_URL, uiPort: ui.address().port }));
      if (['/restart', '/quit', '/crash'].includes(req.url)) {
        callback.close(() => ui.close(() => process.exit(req.url === '/crash' ? 1 : 0)));
      }
    });
    ui.listen(0, '127.0.0.1', () => callback.listen(Number(process.env.PORT), '127.0.0.1', () => {
      fs.appendFileSync(process.argv[2], JSON.stringify({ pid: process.pid,
        restartFile: process.env.PRISMICAL_DEV_RESTART_FILE }) + '\\n');
    }));
    process.on('SIGTERM', () => {
      fs.writeFileSync(process.env.PRISMICAL_DEV_RESTART_FILE, '');
      callback.close(() => ui.close(() => process.exit(0)));
    });
  `
  );
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = process.env.PORTLESS_URL
    ? Number(process.env.PORT)
    : (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = process.env.PORTLESS_URL ?? `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [
      '-e',
      'require(process.argv[1]).runDevRunner(process.execPath, process.argv.slice(2))',
      runner,
      fixture,
      launches,
    ],
    { env: { ...process.env, PORT: String(port), PORTLESS_URL: origin }, stdio: 'pipe' }
  );
  const records = async () =>
    (await readFile(launches, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { pid: number; restartFile: string });
  await vi.waitFor(async () => expect(await records()).toHaveLength(1));
  return { origin, port, records };
}

describe('persistent desktop dev runner', () => {
  it('keeps the callback route and recreates the renderer across requested restarts, then quits', async () => {
    const { origin, port, records } = await start();
    const first = await fetch(`${origin}/oauth/callback`).then(response => response.json());
    expect(await fetch(`http://127.0.0.1:${first.uiPort}`).then(r => r.text())).toBe('renderer');
    await fetch(`${origin}/restart`);
    await vi.waitFor(async () => expect(await records()).toHaveLength(2));
    const second = await fetch(`${origin}/oauth/callback`).then(response => response.json());
    expect(second.pid).not.toBe(first.pid);
    expect(second.port).toBe(String(port));
    expect(second.url).toBe(origin);
    expect(await fetch(`http://127.0.0.1:${second.uiPort}`).then(r => r.text())).toBe('renderer');
    expect(child!.exitCode).toBeNull();
    // The previous restart marker must not turn a normal quit into another restart.
    const exited = once(child!, 'exit');
    await fetch(`${origin}/quit`);
    expect((await exited)[0]).toBe(0);
    expect(await records()).toHaveLength(2);
    await expect(readFile((await records())[0].restartFile)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
  });

  it('does not restart a crashed Forge process even with a pending request', async () => {
    const { origin, records } = await start();
    const exited = once(child!, 'exit');
    await fetch(`${origin}/crash`);
    expect((await exited)[0]).toBe(1);
    expect(await records()).toHaveLength(1);
  });

  it('stops instead of restarting when the launcher receives SIGTERM', async () => {
    const { port, records } = await start();
    const exited = once(child!, 'exit');
    child!.kill('SIGTERM');
    await exited;
    expect(await records()).toHaveLength(1);
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
  });
});
