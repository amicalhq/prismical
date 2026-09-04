/**
 * Verification harness: drive the PACKAGED app's
 * local-whisper stack over a WAV fixture, exactly the way the app does it at
 * runtime — the bundled Node sidecar at Contents/Resources/node forks the
 * unpacked .vite/build/whisper-worker-fork.js, which require()s
 * @prismical/whisper-wrapper from app.asar.unpacked and loads whisper.node.
 * Nothing here shortcuts through the repo's own node_modules: every artifact
 * comes out of the package under --app.
 *
 * usage  tsx scripts/transcribe-fixture.ts --model <ggml.bin> [--app out/Prismical-darwin-arm64]
 *        [--audio tests/fixtures/two-speaker.wav] [--out /tmp/hyp.txt]
 */
import { fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const appDir = path.resolve(
  arg('app') ?? path.join(__dirname, '..', 'out', `Prismical-${process.platform}-${process.arch}`)
);
const modelPath = arg('model') && path.resolve(arg('model')!);
const audioPath = path.resolve(
  arg('audio') ?? path.join(__dirname, '..', 'tests', 'fixtures', 'two-speaker.wav')
);
const outPath = arg('out') && path.resolve(arg('out')!);

if (!modelPath || !existsSync(modelPath)) {
  console.error(`--model <ggml .bin> is required and must exist (got: ${modelPath ?? 'none'})`);
  process.exit(2);
}

const resourcesDir =
  process.platform === 'darwin'
    ? path.join(appDir, 'Prismical.app', 'Contents', 'Resources')
    : path.join(appDir, 'resources');
const nodeBin = path.join(resourcesDir, process.platform === 'win32' ? 'node.exe' : 'node');
const workerJs = path.join(
  resourcesDir,
  'app.asar.unpacked',
  '.vite',
  'build',
  'whisper-worker-fork.js'
);

for (const [label, p] of [
  ['packaged app dir', appDir],
  ['bundled node sidecar', nodeBin],
  ['unpacked whisper worker', workerJs],
  ['audio fixture', audioPath],
] as const) {
  if (!existsSync(p)) {
    console.error(`missing ${label}: ${p}`);
    process.exit(1);
  }
}

/** Minimal WAV reader for the committed fixture: 16 kHz mono PCM16. */
function readWavFloat32(file: string): Float32Array {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bits !== 16) {
        throw new Error(
          `expected 16kHz mono PCM16, got format=${fmt.format} ch=${fmt.channels} rate=${fmt.sampleRate} bits=${fmt.bits}`
        );
      }
      const samples = Math.floor(size / 2);
      const out = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        out[i] = buf.readInt16LE(body + i * 2) / 32768;
      }
      return out;
    }
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk found');
}

const audio = readWavFloat32(audioPath);
console.log(`[fixture] ${audioPath}: ${audio.length} samples (${(audio.length / 16000).toFixed(1)}s)`);
console.log(`[fixture] sidecar: ${nodeBin}`);
console.log(`[fixture] worker : ${workerJs}`);
console.log(`[fixture] model  : ${modelPath}`);

// Mirror SimpleForkWrapper: sidecar node execPath, resources cwd, asar env.
const worker = fork(workerJs, [], {
  execPath: nodeBin,
  cwd: resourcesDir,
  silent: true,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--max-old-space-size=8192',
    APP_ASAR_PATH: path.join(resourcesDir, 'app.asar'),
  },
});
worker.stderr?.on('data', d => process.stderr.write(`[worker:stderr] ${d}`));

let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
worker.on('message', (msg: { id?: number; result?: unknown; error?: string; type?: string; level?: string; message?: string }) => {
  if (msg.type === 'log') {
    console.log(`[worker:${msg.level}] ${msg.message}`);
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error));
    else resolve(msg.result);
  }
});
worker.on('exit', (code, signal) => {
  if (pending.size > 0) {
    console.error(`worker exited early: code=${code} signal=${signal}`);
    process.exit(1);
  }
});

function exec<T>(method: string, args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    const serialized = args.map(a =>
      a instanceof Float32Array ? { __type: 'Float32Array', data: Array.from(a) } : a
    );
    worker.send({ id, method, args: serialized });
  });
}

async function main(): Promise<void> {
  await exec('initializeModel', [modelPath]);
  const started = Date.now();
  const result = await exec<{ text: string; segments: Array<{ text: string; from: number; to: number }> }>(
    'transcribeAudio',
    [
      audio,
      {
        language: 'en',
        initial_prompt: '',
        suppress_blank: true,
        suppress_non_speech_tokens: true,
        no_timestamps: false,
      },
    ]
  );
  const elapsed = Date.now() - started;
  await exec('dispose', []);
  worker.kill();

  console.log(`\n[fixture] transcribed in ${elapsed}ms, ${result.segments.length} segments:`);
  for (const s of result.segments) {
    console.log(`  [${s.from}..${s.to}] ${s.text.trim()}`);
  }
  const text = result.text.trim();
  console.log(`\n[fixture] transcript:\n${text}\n`);
  if (outPath) {
    writeFileSync(outPath, text + '\n');
    console.log(`[fixture] wrote ${outPath}`);
  }
}

main().catch(err => {
  console.error(err);
  worker.kill();
  process.exit(1);
});
