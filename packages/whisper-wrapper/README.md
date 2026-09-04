# @prismical/whisper-wrapper

This package wraps the `whisper.cpp` Node addon so the desktop app can call into
Whisper from a forked worker process. The build and runtime layers are tuned for
the desktop pipeline; the notes below capture the important knobs and the
reasoning behind them.

## Build workflow

- `pnpm --filter @prismical/whisper-wrapper dev:prepare` initializes the
  `whisper.cpp` submodule (v1.8.2 gitlink) and applies the local patches. The
  submodule is OPTIONAL for a plain checkout: `preinstall` (apply-patches)
  and `postinstall` (build-addon `--postinstall`) both no-op cleanly when the
  sources are absent, so `pnpm install` stays green without it — only the
  local-transcription addon is missing until you initialize it.
- With the submodule initialized, `pnpm install` (postinstall) runs
  `bin/build-addon.js --postinstall` via CMake.js and drops the resulting
  `whisper.node` into `native/<platform-arch(-tag)>/`. The postinstall path is
  stamp-aware (`native/<variant>/.build-stamp` records the whisper.cpp HEAD,
  the addon sources, the patch set and the GGML flags) so repeat installs
  skip the rebuild; explicit `build:native` runs always rebuild. A
  postinstall build FAILURE only warns (so a broken cmake toolchain never
  takes down an unrelated root `pnpm install`); forge prePackage and CI
  `test:load` are the loud backstops.
- `pnpm --filter @prismical/whisper-wrapper build` builds the TypeScript
  entrypoint (`dist/`); the desktop worker `require()`s it at runtime.
- `pnpm --filter @prismical/whisper-wrapper build:native` rebuilds the default
  variants for this platform (Metal + CPU on macOS, CPU elsewhere).
- `pnpm --filter @prismical/whisper-wrapper build:native:cuda` builds an extra
  `win32-x64-cuda` binary alongside the regular `win32-x64` fallback. Install
  the CUDA toolkit (12.x tested) before running it.
- Every macOS build is ad-hoc signed (`codesign -s -`) so Electron/Node can load
  it without crashing.
- Each variant is produced as a _single_ `.node` binary. We force static
  libraries (`GGML_STATIC=ON`, `BUILD_SHARED_LIBS=OFF`) so all ggml/whisper
  code is linked directly into the addon—no sidecar `.dylib/.dll` files ship
  at runtime.
- The full CMake build directory is deleted after each variant so Electron
  Forge/Squirrel never sees the long `CMakeFiles/...` paths that blew past
  Windows’ MAX_PATH limit during packaging.

## GPU/CPU fallback

`resolveBinding()` in `src/loader.ts` no longer throws if the first candidate
fails. `loadBinding()` walks the list:

1. `platform-arch-metal`
2. `platform-arch-openblas`
3. `platform-arch-cuda`
4. `platform-arch`
5. `cpu-fallback`

If `require()` raises `ERR_DLOPEN_FAILED` (missing runtime, wrong driver, etc.)
it logs a warning and tries the next candidate. That lets us ship CUDA/Metal
binaries alongside CPU ones without breaking installs that lack the GPU stack.

## GGML_NATIVE on macOS arm64

GitHub’s hosted macOS runners expose `i8mm` but clang refuses to emit the
`vmmlaq_s32` intrinsic when `-mcpu=native` is passed, so the build dies in
`ggml-cpu/arch/arm/quants.c`. Native builds therefore default to
`GGML_NATIVE=OFF`. Locally you can flip it back on if your toolchain supports
those instructions:

```bash
GGML_NATIVE=ON pnpm --filter @prismical/whisper-wrapper build:native
```

Leave it off in CI unless you control the runner.

## Custom targets

`WHISPER_TARGETS` lets you override which variants to build. The value is a
comma-separated list of directory names that should map to `native/<name>`.
Examples:

```bash
WHISPER_TARGETS="linux-x64-gnu" pnpm --filter @prismical/whisper-wrapper build:native
WHISPER_TARGETS="win32-x64-cuda,win32-x64" pnpm --filter @prismical/whisper-wrapper build:native
```

Absent overrides the script builds the Metal variant (on macOS) followed by the
plain CPU build.

## Runtime API

`src/index.ts` exposes a minimal class that mirrors the desktop worker protocol:

- `new Whisper(modelPath, { gpu?: boolean })`
- `await whisper.load()` (no-op placeholder)
- `await whisper.transcribe(audioOrNull, options)`
- `await whisper.free()`

If you pass `null` (and a `fname_inp` in `options`) the addon reads the audio
file directly, matching the CLI smoke tests.

## Voice Activity Detection (VAD)

The addon exposes whisper.cpp's built-in Silero VAD (present since v1.7.6 and
in the pinned v1.8.2, whose `models/` even ships
`for-tests-silero-v5.1.2-ggml.bin`). With VAD on, whisper.cpp runs the VAD
model over the 16 kHz input, decodes only the detected speech spans, and maps
every returned segment's `from`/`to` back onto the ORIGINAL timeline
(`whisper_full_get_segment_t0/t1` consult the state's `vad_mapping_table`), so
callers need no timestamp remapping. Audio with no detected speech returns an
empty segment array instead of a hallucinated line. No ONNX runtime is needed:
the VAD model is a ggml file evaluated by the same static ggml build.

The VAD model is NOT bundled. Download it from whisper.cpp's model repo (this is
what `whisper.cpp/models/download-vad-model.sh silero-v5.1.2` fetches; the
HF card and upstream silero-vad are MIT):

```
https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
  885098 bytes, sha1 a372f48dcf0bd9e4330eef2802bc46e061c19634
```

`full(handle, options)` / `whisper.transcribe(audio, options)` accept these keys
(names follow the `whisper-cli --vad-*` flags; every default comes from
`whisper_vad_default_params()`):

| option                        | type    | default | maps to                               |
| ----------------------------- | ------- | ------- | ------------------------------------- |
| `vad`                         | boolean | `false` | `whisper_full_params.vad`             |
| `vad_model_path`              | string  | —       | `whisper_full_params.vad_model_path`  |
| `vad_threshold`               | float   | `0.5`   | `vad_params.threshold`                |
| `vad_min_speech_duration_ms`  | int     | `250`   | `vad_params.min_speech_duration_ms`   |
| `vad_min_silence_duration_ms` | int     | `100`   | `vad_params.min_silence_duration_ms`  |
| `vad_max_speech_duration_s`   | float   | `FLT_MAX` (no split) | `vad_params.max_speech_duration_s` |
| `vad_speech_pad_ms`           | int     | `30`    | `vad_params.speech_pad_ms`            |
| `vad_samples_overlap`         | float   | `0.1`   | `vad_params.samples_overlap`          |

Caveats that come from whisper.cpp, not the addon:

- `vad: true` without `vad_model_path` throws a `TypeError` up front (whisper.cpp
  would open a null path). A path that does not exist, or a truncated file
  ("not all tensors loaded"), fails inside `whisper_full` and surfaces as the
  generic `whisper_full_parallel failed` error; the reason is on stderr.
- A file that is a ggml model but NOT a Silero VAD model (e.g. a whisper
  `ggml-*.bin`) ABORTS the process: whisper.cpp only checks the ggml magic, does
  not validate the `silero-16k` model-type string, reads garbage hyper-params and
  dies on `GGML_ASSERT`. Only pass checksum-verified VAD files.
- The VAD context is created lazily on the first VAD call and cached on the
  whisper state for the life of the handle: a different `vad_model_path` on a
  later call on the same handle is ignored. Re-`init` the model to swap it.
- VAD always runs on CPU (4 threads, `whisper_vad_default_context_params()`);
  the `gpu` flag only affects the whisper model.
- Input must be 16 kHz mono (the model is `silero-16k`); `vad_samples_overlap`
  and `vad_speech_pad_ms` extend each span, so short gaps between phrases are
  usually decoded as part of the neighbouring speech.

`node scripts/test-vad.js` runs the fixture with and without VAD and asserts
the transcripts match and that 5 s of zeros yields no segments (see the header
for the flags).

## Patches

Local patches in `patches/` are applied to the whisper.cpp submodule automatically
during `pnpm --filter @prismical/whisper-wrapper dev:prepare` and during
`pnpm install` when package lifecycle scripts are enabled. The apply script is
idempotent — already-applied patches are skipped.

### fix-no-speech-prob-sot-position.patch

whisper.cpp (as of v1.8.2 and current master) computes `no_speech_prob` from the
wrong decoder position. It reads logits at the **last prompt token** (e.g.
`<|notimestamps|>`), where the model predicts the first word of text. The original
Python whisper reads from the **SOT position**, where the model decides whether
speech is present at all.

The result: `no_speech_prob` is always near zero regardless of audio content, making
whisper.cpp's built-in no-speech filtering (`no_speech_thold`, default 0.6) dead code.

The patch adds two lines:

1. Mark the SOT position for logit extraction (`batch.logits[sot_index] = 1`)
2. Read `no_speech_prob` from the SOT offset instead of the last position

With the fix, large-v3 (32 decoder layers) returns ~0.7 on silence. Large-v3-turbo
(4 decoder layers) still returns near-zero — this is a model limitation due to its
reduced decoder, not a code bug.

To add a new patch, drop a `.patch` file in `patches/` (they're applied in
alphabetical order). REMOVING a patch does not un-apply it from an
already-patched submodule working tree — the stamp changes and triggers a
rebuild of a tree that still carries the old patch. After deleting a patch,
reset the submodule first (`git -C whisper.cpp checkout -- .`, or
`git submodule update --checkout`) and rebuild. If a whisper.cpp version bump breaks a patch, the build will
fail, prompting you to check whether the fix was merged upstream.

## Local expectations

- `whisper.cpp` is tracked as a submodule under `packages/whisper-wrapper/`
  (initialize with `dev:prepare`; uninitialized checkouts skip every hook).
- `cmake-js` / `node` / `pnpm` must be installed (the workspace root sets the
  required versions).
- The build creates `.cmake-js/` and `.home/` caches inside the package; they’re
  ignored in git.

For any tweaks (new build targets, additional fallbacks, etc.) update this file
so the CI configuration stays discoverable.
