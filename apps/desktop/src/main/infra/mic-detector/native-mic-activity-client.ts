import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { makeLineDecoder } from '@desktop/logging';
import { makeProcessDiagnostics } from '../logging/process-diagnostics';
import type { SyncScopedLog, LoggingTransportService } from '../logging/service';
import { z } from 'zod';
import { assertMicDetectorBinaryExists } from './mic-detector-binary';
import type { MicActivitySnapshotEvent } from '@/types/meeting-start-notifications';

export const SnapshotMessageSchema = z.object({
  type: z.literal('snapshot'),
  timestampMs: z.number(),
  apps: z.array(
    z.object({
      bundleId: z.string(),
      pid: z.number().int(),
      detectedAtMs: z.number(),
      applicationName: z.string().optional(),
      inputDevices: z
        .array(
          z.object({
            uid: z.string(),
            name: z.string(),
          })
        )
        .optional(),
    })
  ),
});

interface NativeMicActivityClientEvents {
  snapshot: (event: MicActivitySnapshotEvent) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class NativeMicActivityClient extends EventEmitter {
  private stopping = false;
  constructor(
    private readonly log: SyncScopedLog,
    private readonly transport: LoggingTransportService
  ) {
    super();
  }
  private process: ChildProcessByStdio<Writable, Readable, Readable> | null = null;

  on<U extends keyof NativeMicActivityClientEvents>(
    event: U,
    listener: NativeMicActivityClientEvents[U]
  ): this {
    return super.on(event, listener);
  }

  off<U extends keyof NativeMicActivityClientEvents>(
    event: U,
    listener: NativeMicActivityClientEvents[U]
  ): this {
    return super.off(event, listener);
  }

  emit<U extends keyof NativeMicActivityClientEvents>(
    event: U,
    ...args: Parameters<NativeMicActivityClientEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Native mic activity detector is already running.');
    }

    const binaryPath = assertMicDetectorBinaryExists();

    this.log.info('Starting native mic detector');
    this.stopping = false;
    const child = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;

    child.stdin.on('error', error => {
      this.log.warn('Native mic detector stdin error', {
        error,
      });
    });

    const stdout = makeLineDecoder();
    child.stdout.on('data', (chunk: Buffer) => {
      const { lines, dropped } = stdout.push(chunk);
      if (dropped)
        this.log.warn('Oversized microphone snapshots discarded', {
          context: { droppedLines: dropped },
        });
      for (const line of lines) {
        try {
          const parsed = SnapshotMessageSchema.safeParse(JSON.parse(line));
          if (parsed.success) this.emit('snapshot', parsed.data);
          else this.log.warn('Ignoring invalid microphone snapshot');
        } catch {
          this.log.warn('Ignoring malformed microphone snapshot');
        }
      }
    });
    const diagnostics = makeProcessDiagnostics(
      this.transport,
      () => ({ runtime: 'native', pid: child.pid ?? process.pid }),
      'mic-detector'
    );
    child.stderr.on('data', diagnostics.push);
    child.stderr.on('end', diagnostics.end);

    child.on('error', error => {
      this.log.error('Native microphone detector failed', { error });
      this.emit('error', error);
    });

    child.on('exit', (code, signal) => {
      this.log[this.stopping ? 'info' : 'error']('Native mic detector exited', {
        context: { code, signal, expected: this.stopping },
      });
      this.process = null;
      this.emit('exit', code, signal);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    const child = this.process;
    this.stopping = true;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1500);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      if (process.platform === 'win32') {
        child.stdin.end('stop\n');
      } else {
        child.kill('SIGTERM');
      }
    });
  }
}
