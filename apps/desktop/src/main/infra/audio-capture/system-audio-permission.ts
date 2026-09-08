import { spawn } from 'node:child_process';
import type { SyncScopedLog } from '../logging/service';
import { assertAudioCaptureBinaryExists } from './audio-capture-binary';

export interface SystemAudioPermissionResult {
  granted: boolean;
  details?: string;
}

export async function checkSystemAudioPermission(
  log: SyncScopedLog
): Promise<SystemAudioPermissionResult> {
  if (process.platform !== 'darwin') {
    return { granted: true };
  }

  const binaryPath = assertAudioCaptureBinaryExists();

  return await new Promise<SystemAudioPermissionResult>(resolve => {
    const child = spawn(binaryPath, ['--mode', 'system', '--check-system-audio-permission'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        granted: false,
        details: 'System audio permission probe timed out',
      });
    }, 4000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });

    child.on('error', error => {
      clearTimeout(timeout);
      log.error('Failed to run system audio permission probe', { error });
      resolve({
        granted: false,
        details: error.message,
      });
    });

    child.on('exit', code => {
      clearTimeout(timeout);
      const details = stderr.trim() || undefined;
      resolve({
        granted: code === 0,
        details,
      });
    });
  });
}
