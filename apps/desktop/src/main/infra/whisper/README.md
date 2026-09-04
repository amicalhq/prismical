# Whisper infrastructure

This directory contains the on-device whisper.cpp worker host. It uses
whisper.cpp's native VAD; `packages/whisper-wrapper/README.md` documents the
pinned upstream version, patches, build inputs, and distributed model files.

- `protocol.ts` — the worker IPC contract (request/response/log frames, the
  `{ __type: 'Float32Array', data }` serialization, `WhisperDecodeOptions`).
  Types only; shared by both sides.
- `whisper-worker-fork.ts` — the worker entry, bundled by vite as
  `.vite/build/whisper-worker-fork.js` (second rollup input in
  `vite.main.config.mts`) and forked under the bundled Node SIDECAR.
  `initializeModel` runs the GPU policy; `transcribeAudio` pads to ≥1.25 s,
  passes the options VERBATIM to the addon, then applies the hallucination
  filter (`../audio/segment-filter.ts`) and clamps timestamps.
- `whisper-gpu-policy.ts` — `decideWhisperGpuUse` /
  `resolveWhisperGpuDecision` (GPU everywhere except Intel-only darwin-x64).
- `service.ts` / `engine.ts` — `WhisperEngine`, the boot-scoped host: lazy
  fork under the sidecar (paths documented in engine.ts), one call in flight,
  model cached by path, typed `WhisperEngineError`, killed on timeout and at
  boot-scope close. `domains/transcriber/local.ts` is its consumer.

Dev: `pnpm download-node` fetches the sidecar; `pnpm build:worker` rebuilds the
worker bundle without a full forge run (`pnpm test:local-asr` does both the
build and the real end-to-end integration test).

This directory stays excluded from `tests/static-gate.test.ts` (the worker is
plain Node) but is type-checked and linted like the rest of `src/main`.
