import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

export function resolveEventKitBinaryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'prismical-eventkit');
  }
  return path.join(
    process.cwd(),
    '..',
    '..',
    'packages',
    'native-helpers',
    'eventkit',
    'bin',
    'prismical-eventkit'
  );
}

export function assertEventKitBinaryExists(): string {
  const binaryPath = resolveEventKitBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Native EventKit helper not found at ${binaryPath}. Run pnpm --filter @prismical/eventkit-helper build.`
    );
  }
  return binaryPath;
}
