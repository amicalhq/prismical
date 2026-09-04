/**
 * Fetch a catalogue whisper model into the EVAL model cache.
 *
 * The local ASR integration tests and e2e local-mode helpers read weights from
 * `~/.cache/prismical/models` (override with
 * `PRISMICAL_MODEL_CACHE`) - never from an installed app's userData profile. This script fills
 * that cache: download to `<filename>.part`, streaming SHA-1, rename into place only when the
 * digest matches the pin. Idempotent: an already-present, already-valid file is left alone.
 * Prints the absolute path on its last stdout line.
 *
 * The id -> (filename, url, sha1) table below mirrors
 * src/main/domains/models/catalogue.ts. It is a copy on purpose: this script
 * must run with nothing but Node and must not import the models domain.
 *
 * usage  tsx scripts/fetch-eval-model.ts [--model whisper-base-en] [--cache <dir>]
 * exit   0 ok · 1 download / checksum failure · 2 usage
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

interface EvalModel {
  id: string;
  filename: string;
  url: string;
  sha1: string;
  sizeBytes: number;
}

const HF_WHISPER_CPP = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const HF_WHISPER_VAD = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main';

/** Mirror of MODEL_CATALOGUE (src/main/domains/models/catalogue.ts). */
const EVAL_MODELS: readonly EvalModel[] = [
  {
    id: 'whisper-base-en',
    filename: 'ggml-base.en.bin',
    url: `${HF_WHISPER_CPP}/ggml-base.en.bin`,
    sha1: '137c40403d78fd54d454da0f9bd998f78703390c',
    sizeBytes: 147_964_211,
  },
  {
    id: 'whisper-tiny',
    filename: 'ggml-tiny.bin',
    url: `${HF_WHISPER_CPP}/ggml-tiny.bin`,
    sha1: 'bd577a113a864445d4c299885e0cb97d4ba92b5f',
    sizeBytes: Math.round(77.7 * 1024 * 1024),
  },
  {
    id: 'whisper-base',
    filename: 'ggml-base.bin',
    url: `${HF_WHISPER_CPP}/ggml-base.bin`,
    sha1: '465707469ff3a37a2b9b8d8f89f2f99de7299dac',
    sizeBytes: 148 * 1024 * 1024,
  },
  {
    id: 'whisper-small',
    filename: 'ggml-small.bin',
    url: `${HF_WHISPER_CPP}/ggml-small.bin`,
    sha1: '55356645c2b361a969dfd0ef2c5a50d530afd8d5',
    sizeBytes: 488 * 1024 * 1024,
  },
  {
    id: 'whisper-medium',
    filename: 'ggml-medium.bin',
    url: `${HF_WHISPER_CPP}/ggml-medium.bin`,
    sha1: 'fd9727b6e1217c2f614f9b698455c4ffd82463b4',
    sizeBytes: Math.round(1.53 * 1024 * 1024 * 1024),
  },
  {
    id: 'whisper-large-v3',
    filename: 'ggml-large-v3.bin',
    url: `${HF_WHISPER_CPP}/ggml-large-v3.bin`,
    sha1: 'ad82bf6a9043ceed055076d0fd39f5f186ff8062',
    sizeBytes: Math.round(3.1 * 1024 * 1024 * 1024),
  },
  {
    id: 'whisper-large-v3-turbo',
    filename: 'ggml-large-v3-turbo.bin',
    url: `${HF_WHISPER_CPP}/ggml-large-v3-turbo.bin`,
    sha1: '4af2b29d7ec73d781377bfd1758ca957a807e941',
    sizeBytes: Math.round(1.5 * 1024 * 1024 * 1024),
  },
  // The VAD weights (kind 'vad' in the desktop catalogue — not an ASR model;
  // the integration test's VAD variant reads this file from the cache).
  {
    id: 'silero-vad-v5',
    filename: 'ggml-silero-v5.1.2.bin',
    url: `${HF_WHISPER_VAD}/ggml-silero-v5.1.2.bin`,
    sha1: 'a372f48dcf0bd9e4330eef2802bc46e061c19634',
    sizeBytes: 885_098,
  },
];

const DEFAULT_MODEL_ID = 'whisper-base-en';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function cacheDir(): string {
  const flag = arg('cache');
  if (flag !== undefined && flag.trim().length > 0) return path.resolve(flag);
  const env = process.env.PRISMICAL_MODEL_CACHE;
  if (env !== undefined && env.trim().length > 0) return path.resolve(env);
  return path.join(homedir(), '.cache', 'prismical', 'models');
}

function sha1File(file: string): string {
  const hash = createHash('sha1');
  const fd = openSync(file, 'r');
  try {
    const block = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const read = readSync(fd, block, 0, block.length, null);
      if (read === 0) break;
      hash.update(block.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function download(model: EvalModel, dest: string): Promise<void> {
  const part = `${dest}.part`;
  const res = await fetch(model.url, { redirect: 'follow' });
  if (!res.ok || res.body === null) {
    throw new Error(`GET ${model.url} -> HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? model.sizeBytes);
  const hash = createHash('sha1');
  let received = 0;
  let nextReport = 0.1;
  const tally = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (total > 0 && received / total >= nextReport) {
        console.log(`[fetch-eval-model] ${mb(received)} / ${mb(total)} (${Math.round((received / total) * 100)}%)`);
        nextReport += 0.1;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      tally,
      createWriteStream(part)
    );
    const digest = hash.digest('hex');
    if (digest !== model.sha1) {
      throw new Error(`checksum mismatch for ${model.filename}: got sha1 ${digest}, expected ${model.sha1}`);
    }
    renameSync(part, dest);
  } catch (err) {
    if (existsSync(part)) unlinkSync(part);
    throw err;
  }
}

async function main(): Promise<number> {
  const id = arg('model') ?? DEFAULT_MODEL_ID;
  const model = EVAL_MODELS.find(m => m.id === id);
  if (model === undefined) {
    console.error(`unknown model id "${id}" - one of ${EVAL_MODELS.map(m => m.id).join(', ')}`);
    return 2;
  }
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, model.filename);

  if (existsSync(dest)) {
    const digest = sha1File(dest);
    if (digest === model.sha1) {
      console.log(`[fetch-eval-model] ${model.id} already present and verified (${mb(statSync(dest).size)})`);
      console.log(dest);
      return 0;
    }
    console.log(`[fetch-eval-model] ${dest} has sha1 ${digest}, expected ${model.sha1} - re-downloading`);
    unlinkSync(dest);
  }

  console.log(`[fetch-eval-model] ${model.id}: ${model.url} -> ${dest} (~${mb(model.sizeBytes)})`);
  await download(model, dest);
  console.log(`[fetch-eval-model] verified sha1 ${model.sha1}`);
  console.log(dest);
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[fetch-eval-model] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
