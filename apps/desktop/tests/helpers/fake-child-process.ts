/**
 * Fake `node:child_process` spawn for the CaptureProvider tests. A single
 * module-level control (installed per test via `installFakeSpawn`)
 * lets the vi.mock factory hand the provider a controllable child while the test
 * drives it: push real 32-byte packets to stdout, `aec=` lines to stderr, and
 * simulate exit / crash / spawn failure. NO real binary, no Electron.
 */
import { EventEmitter } from "node:events";

class FakeStream extends EventEmitter {
  /** Push a chunk to any `data` listener, exactly as a real pipe would. */
  pushData(chunk: Buffer | string): void {
    this.emit("data", typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
}

class FakeStdin extends EventEmitter {
  ended: string[] = [];
  writes: string[] = [];
  end(data?: string): void {
    if (data !== undefined) this.ended.push(data);
  }
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
}

export class FakeChildProcess extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly command: string;
  readonly args: string[];
  readonly killSignals: NodeJS.Signals[] = [];
  running = true;
  private readonly autoExitOnSigterm: boolean;

  constructor(
    command: string,
    args: string[],
    config: { autoExitOnSigterm: boolean },
  ) {
    super();
    this.command = command;
    this.args = args;
    this.autoExitOnSigterm = config.autoExitOnSigterm;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (!this.running) return false;
    const sig = signal ?? "SIGTERM";
    this.killSignals.push(sig);
    // SIGKILL always ends it; SIGTERM ends it unless the child is configured to
    // ignore SIGTERM (so a test can exercise the SIGKILL grace fallback).
    if (sig === "SIGKILL" || (sig === "SIGTERM" && this.autoExitOnSigterm)) {
      this.simulateExit(null, sig);
    }
    return true;
  }

  /** Test driver: the child dies on its own (crash / unexpected exit / signal). */
  simulateExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.running) return;
    this.running = false;
    this.emit("exit", code, signal);
  }

  /** Test driver: the child emits a process `error` (async spawn/IO failure). */
  simulateError(error: Error): void {
    this.emit("error", error);
  }
}

interface FakeSpawnConfig {
  /** Next spawn: throw synchronously (unspawnable command). */
  spawnError?: Error;
  /** Next binary resolution: throw (binary not found). */
  binaryError?: Error;
  /** Child's SIGTERM behavior (default true = exits on SIGTERM). */
  autoExitOnSigterm?: boolean;
}

export interface FakeSpawnControl {
  readonly children: FakeChildProcess[];
  readonly last: () => FakeChildProcess;
  /** Configure the behavior of the NEXT spawn / binary resolution. */
  readonly configureNext: (config: FakeSpawnConfig) => void;
}

let control: (FakeSpawnControl & { config: FakeSpawnConfig }) | null = null;

/** Reset + install a fresh fake spawn control (call in beforeEach). */
export const installFakeSpawn = (): FakeSpawnControl => {
  const children: FakeChildProcess[] = [];
  control = {
    children,
    config: {},
    last: () => {
      const child = children[children.length - 1];
      if (!child) throw new Error("no child spawned yet");
      return child;
    },
    configureNext: (config) => {
      if (control) control.config = config;
    },
  };
  return control;
};

const requireControl = (): FakeSpawnControl & { config: FakeSpawnConfig } => {
  if (!control) throw new Error("fake spawn not installed");
  return control;
};

/** vi.mock target for `spawn`. */
export const fakeSpawn = (command: string, args: string[]): FakeChildProcess => {
  const ctrl = requireControl();
  const { config } = ctrl;
  ctrl.config = {};
  if (config.spawnError) throw config.spawnError;
  const child = new FakeChildProcess(command, args, {
    autoExitOnSigterm: config.autoExitOnSigterm ?? true,
  });
  ctrl.children.push(child);
  return child;
};

/** vi.mock target for `assertAudioCaptureBinaryExists`. */
export const fakeBinaryPath = (): string => {
  const ctrl = requireControl();
  if (ctrl.config.binaryError) throw ctrl.config.binaryError;
  return "/fake/bin/audio-capture";
};
