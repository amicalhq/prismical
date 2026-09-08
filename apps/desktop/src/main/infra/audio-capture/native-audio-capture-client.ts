import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { SyncScopedLog, LoggingTransportService } from '../logging/service';
import { makeProcessDiagnostics } from '../logging/process-diagnostics';
import type { AudioFrame, MeetingCaptureMode } from '@/types/meeting';
import { assertAudioCaptureBinaryExists } from './audio-capture-binary';
import { createPacketReader, parseAecMode, type PacketReader } from './packet-protocol';

interface NativeAudioCaptureEvents {
  frame: (frame: AudioFrame) => void;
  'aec-mode': (mode: string) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class NativeAudioCaptureClient extends EventEmitter {
  private process: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private reader: PacketReader = createPacketReader();
  private stopping = false;
  private diagnostics: ReturnType<typeof makeProcessDiagnostics>;
  constructor(
    private readonly log: SyncScopedLog,
    private readonly transport: LoggingTransportService
  ) {
    super();
    this.diagnostics = this.makeDiagnostics();
  }
  private makeDiagnostics() {
    return makeProcessDiagnostics(
      this.transport,
      () => ({ runtime: 'native', pid: this.process?.pid ?? process.pid }),
      'audio-capture',
      line => {
        const mode = parseAecMode(line);
        if (mode) this.emit('aec-mode', mode);
        return mode !== null && !line.startsWith('{');
      }
    );
  }

  on<U extends keyof NativeAudioCaptureEvents>(
    event: U,
    listener: NativeAudioCaptureEvents[U]
  ): this {
    return super.on(event, listener);
  }

  off<U extends keyof NativeAudioCaptureEvents>(
    event: U,
    listener: NativeAudioCaptureEvents[U]
  ): this {
    return super.off(event, listener);
  }

  emit<U extends keyof NativeAudioCaptureEvents>(
    event: U,
    ...args: Parameters<NativeAudioCaptureEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  async start(
    mode: MeetingCaptureMode,
    options?: {
      debugArtifactsDir?: string;
      aecRenderHoldbackMs?: number;
      aecRenderWaitTimeoutMs?: number;
    }
  ): Promise<void> {
    if (this.process) {
      throw new Error('Native audio capture is already running.');
    }

    const binaryPath = assertAudioCaptureBinaryExists();

    this.log.info('Starting native audio capture', { context: { mode } });
    this.reader = createPacketReader();
    this.stopping = false;
    this.diagnostics = this.makeDiagnostics();
    const args = ['--mode', mode];
    if (options?.debugArtifactsDir) {
      args.push('--debug-artifacts-dir', options.debugArtifactsDir);
    }
    if (options?.aecRenderHoldbackMs != null) {
      args.push('--aec-render-holdback-ms', String(options.aecRenderHoldbackMs));
    }
    if (options?.aecRenderWaitTimeoutMs != null) {
      args.push('--aec-render-wait-timeout-ms', String(options.aecRenderWaitTimeoutMs));
    }

    const captureProcess = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = captureProcess;

    captureProcess.stdin.on('error', error => {
      this.log.warn('Native audio capture stdin error', {
        error,
      });
    });

    captureProcess.stdout.on('data', (data: Buffer) => {
      this.handleStdoutData(data);
    });

    captureProcess.stderr.on('data', (data: Buffer) => {
      this.handleStderrData(data);
    });

    captureProcess.on('error', error => {
      this.log.error('Native audio capture failed', { error });
      this.emit('error', error);
    });

    captureProcess.on('exit', (code, signal) => {
      this.diagnostics.end();
      this.log[this.stopping ? 'info' : 'error']('Native audio capture exited', {
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

    const captureProcess = this.process;
    this.stopping = true;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        captureProcess.kill('SIGKILL');
      }, 1500);

      captureProcess.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      if (process.platform === 'win32') {
        captureProcess.stdin.end('stop\n');
      } else {
        captureProcess.kill('SIGTERM');
      }
    });
  }

  private handleStdoutData(chunk: Buffer): void {
    for (const frame of this.reader.push(chunk)) {
      this.emit('frame', frame);
    }
  }

  private handleStderrData(chunk: Buffer): void {
    this.diagnostics.push(chunk);
  }
}
