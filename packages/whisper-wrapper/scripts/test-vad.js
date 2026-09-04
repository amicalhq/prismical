#!/usr/bin/env node
// Probe for the addon's built-in Silero VAD path (whisper.cpp `vad*` params).
//
// Usage:
//   node scripts/test-vad.js [--model=/path/ggml-*.bin] [--vad-model=/path/ggml-silero-*.bin]
//                            [--audio=/path/16k-mono-pcm16.wav] [--variant=darwin-arm64]
//                            [--vad-<param>=<value> ...]
//
// Defaults: ~/.cache/prismical/models/ggml-base.en.bin, ~/.cache/prismical/models/
// ggml-silero-v5.1.2.bin and apps/desktop/tests/fixtures/two-speaker.wav. Any
// `--vad-threshold`, `--vad-min-speech-duration-ms`, `--vad-min-silence-duration-ms`,
// `--vad-max-speech-duration-s`, `--vad-speech-pad-ms`, `--vad-samples-overlap`
// flag overrides the whisper-cli default of the same name. `--variant` pins a
// native/<variant>/whisper.node instead of the GPU-first candidate walk.
//
// Runs `full` over the fixture once without VAD and once with it, prints both
// transcripts + timelines, and asserts:
//   1. the VAD transcript is non-empty and, normalized, equals the no-VAD one
//      (the fixture is clean speech with natural gaps - VAD must not lose words);
//   2. five seconds of digital silence with VAD on yields zero segments.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURE = path.resolve(__dirname, "..", "..", "..", "apps", "desktop", "tests", "fixtures", "two-speaker.wav");
const MODELS_DIR = path.join(os.homedir(), ".cache", "prismical", "models");

// whisper-cli defaults (examples/cli/cli.cpp), except max_speech_duration_s
// which the CLI leaves at FLT_MAX; 30 s matches whisper's decode window.
const VAD_DEFAULTS = {
  vad_threshold: 0.5,
  vad_min_speech_duration_ms: 250,
  vad_min_silence_duration_ms: 100,
  vad_max_speech_duration_s: 30,
  vad_speech_pad_ms: 30,
  vad_samples_overlap: 0.1,
};

const DECODE_OPTIONS = {
  language: "en",
  no_timestamps: false,
  suppress_blank: true,
  suppress_non_speech_tokens: true,
};

function resolveBinding(variant) {
  const nativeRoot = path.resolve(__dirname, "..", "native");
  const { platform, arch } = process;
  const candidates = variant ? [variant] : [
    `${platform}-${arch}-metal`,
    `${platform}-${arch}-openblas`,
    `${platform}-${arch}-cuda`,
    `${platform}-${arch}`,
    "cpu-fallback",
  ];
  for (const dir of candidates) {
    const bindingPath = path.join(nativeRoot, dir, "whisper.node");
    if (fs.existsSync(bindingPath)) return bindingPath;
  }
  throw new Error(`Unable to locate a whisper.node binary (${candidates.join(", ")}).`);
}

function parseArgs() {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    if (value === undefined) throw new Error(`Flag '${arg}' must be provided as --${key}=<value>`);
    options[key] = value;
  }
  return options;
}

// Minimal RIFF reader: 16 kHz mono PCM16 only (what whisper.cpp expects).
function readWavFloat32(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error(`${file}: data chunk before fmt chunk`);
      if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bitsPerSample !== 16) {
        throw new Error(`${file}: expected 16 kHz mono PCM16, got ${JSON.stringify(fmt)}`);
      }
      const n = Math.floor(Math.min(size, buf.length - body) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2) / 32768;
      return out;
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function printSegments(label, segments) {
  console.log(`\n${label}: ${segments.length} segment(s)`);
  for (const s of segments) {
    console.log(`  [${String(s.from).padStart(6)} -> ${String(s.to).padStart(6)} ms] nsp=${s.noSpeechProb.toFixed(3)} ${JSON.stringify(s.text)}`);
  }
}

function main() {
  const args = parseArgs();
  const modelPath = path.resolve(args.model || path.join(MODELS_DIR, "ggml-base.en.bin"));
  const vadModelPath = path.resolve(args["vad-model"] || path.join(MODELS_DIR, "ggml-silero-v5.1.2.bin"));
  const audioPath = path.resolve(args.audio || FIXTURE);
  for (const file of [modelPath, vadModelPath, audioPath]) {
    if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  }

  const vadOptions = { vad: true, vad_model_path: vadModelPath, ...VAD_DEFAULTS };
  for (const key of Object.keys(VAD_DEFAULTS)) {
    const flag = key.replace(/_/g, "-");
    if (args[flag] !== undefined) vadOptions[key] = Number(args[flag]);
  }

  const bindingPath = resolveBinding(args.variant);
  console.log(`> addon:     ${bindingPath}`);
  console.log(`> model:     ${modelPath}`);
  console.log(`> vad model: ${vadModelPath}`);
  console.log(`> audio:     ${audioPath}`);
  console.log(`> vad opts:  ${JSON.stringify({ ...vadOptions, vad_model_path: "<above>" })}`);

  const binding = require(bindingPath);
  const audio = readWavFloat32(audioPath);
  console.log(`> audio:     ${audio.length} samples @16 kHz = ${(audio.length / 16000).toFixed(2)} s`);

  const handle = binding.init({ model: modelPath, gpu: true });
  const failures = [];
  try {
    const plain = binding.full(handle, { audio, ...DECODE_OPTIONS });
    printSegments("WITHOUT vad", plain);
    const plainText = plain.map((s) => s.text).join("");
    console.log(`  text: ${JSON.stringify(plainText.trim())}`);

    const withVad = binding.full(handle, { audio, ...DECODE_OPTIONS, ...vadOptions });
    printSegments("WITH vad", withVad);
    const vadText = withVad.map((s) => s.text).join("");
    console.log(`  text: ${JSON.stringify(vadText.trim())}`);

    const a = normalize(plainText);
    const b = normalize(vadText);
    console.log(`\nnormalized no-vad: ${JSON.stringify(a)}`);
    console.log(`normalized vad:    ${JSON.stringify(b)}`);
    if (b.length === 0) failures.push("VAD transcript is empty");
    if (a !== b) failures.push("VAD transcript differs from the no-VAD transcript");

    const silence = new Float32Array(5 * 16000);
    const silenceVad = binding.full(handle, { audio: silence, ...DECODE_OPTIONS, ...vadOptions });
    printSegments("5 s zeros WITH vad", silenceVad);
    if (silenceVad.length !== 0) failures.push(`expected 0 segments on silence with VAD, got ${silenceVad.length}`);

    // Informational only: what the same silence decodes to without VAD.
    const silencePlain = binding.full(handle, { audio: silence, ...DECODE_OPTIONS });
    printSegments("5 s zeros WITHOUT vad (informational)", silencePlain);
  } finally {
    binding.free(handle);
  }

  if (failures.length > 0) {
    console.error(`\nFAIL:\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nPASS: VAD transcript matches no-VAD transcript; silence yields no segments.");
}

try {
  main();
} catch (err) {
  console.error("Probe failed:", err);
  process.exitCode = 1;
}
