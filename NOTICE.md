# Third-party notices

Provenance record for the third-party components this repository bundles, pins,
or downloads at runtime. Everything else is resolved from npm through
`pnpm-lock.yaml` (JavaScript) or from NuGet through the `*.csproj` files (the
Windows helpers).

## whisper.cpp (git submodule)

- Path: `packages/whisper-wrapper/whisper.cpp`
- Source: https://github.com/ggerganov/whisper.cpp
- Pin: v1.8.2 (`4979e04f5dcaccb36057e059bbaed8a2f5288315`)
- License: MIT (see the submodule's `LICENSE`)
- Includes the ggml tensor library (MIT) under `whisper.cpp/ggml`.
- Local modification: `packages/whisper-wrapper/patches/
  fix-no-speech-prob-sot-position.patch` is applied to the working tree at
  install time (see the wrapper README for the rationale); the pinned upstream
  commit itself is unmodified.

## Whisper models (downloaded on demand, never redistributed)

- The desktop app downloads ggml Whisper models from the whisper.cpp model
  catalogue on Hugging Face (https://huggingface.co/ggerganov/whisper.cpp)
  when a user picks one; every download is verified against a pinned SHA-1
  before it is adopted. Nothing is bundled in this repository or shipped in
  the app bundle. The Whisper weights are released by OpenAI under the MIT
  License (https://github.com/openai/whisper).

## Silero VAD model weights (downloaded on demand, never redistributed)

- The desktop app downloads the ggml Silero VAD model on demand (model
  catalogue entry `silero-vad-v5`; auto-fetched beside the first whisper
  model). Nothing is bundled in this repository or shipped in the app bundle.
- Artifact: https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
  (885098 bytes, SHA-1 `a372f48dcf0bd9e4330eef2802bc46e061c19634`; the pin is
  enforced at download and adopt time).
- Source project: https://github.com/snakers4/silero-vad — MIT — converted to
  ggml in whisper.cpp's own VAD model repo,
  https://huggingface.co/ggml-org/whisper-vad (MIT per its model card).

## WebRTC audio processing (AEC3) — prebuilt bundle

- Path: `packages/native-helpers/audio-capture/Vendor/WebRTC/`
  (`macOS/lib/libprismical_webrtc_aec3.a`, universal arm64 + x86_64;
  `windows/x64/bin/prismical_webrtc_aec3.dll` + import library).
- Source: Google's WebRTC project, https://webrtc.googlesource.com/src,
  revision `373edbca7233475487f419c9aea6238e05853dd9`, built by
  `packages/webrtc-aec3-builder` (the `BUILD_INFO.txt` next to each bundle
  records the revision and build date). Only the audio-processing subset is
  compiled, behind the small C bridge declared in
  `packages/native-helpers/audio-capture/Sources/Aec3Bridge/include/prismical_aec3.h`.
- License: BSD 3-Clause (https://webrtc.googlesource.com/src/+/refs/heads/main/LICENSE),
  with the additional patent grant in that repository's `PATENTS` file. The
  bundle links WebRTC's own third-party dependencies under their respective
  licenses (see `third_party/` in the WebRTC tree at the pinned revision).

## Windows recording helpers (.NET)

- Paths: `packages/native-helpers/audio-capture/windows/AudioCapture.Windows.csproj`,
  `packages/native-helpers/mic-detector/windows/PrismicalMicDetector.Windows.csproj`.
- Both helpers depend on NAudio 2.2.1 (MIT, https://github.com/naudio/NAudio) and are
  published self-contained, so the Windows package embeds the Microsoft .NET 8 runtime
  (MIT, with its own third-party notices — https://github.com/dotnet/runtime).

## Node.js runtime sidecar (packaged builds only)

- Packaged desktop builds bundle an unmodified official Node.js binary
  (nodejs.org dist, version pinned in
  `apps/desktop/scripts/download-node-binaries.ts`) at
  `Contents/Resources/node` to run the whisper transcription worker
  out-of-process. Node.js is distributed under the Node.js license
  (MIT-style, with bundled third-party notices) — see
  https://github.com/nodejs/node/blob/main/LICENSE.

## Ubuntu font

- Path: `packages/app-ui/src/fonts/ubuntu-latin-{400,500,700}-normal.woff2`
- Source: the Ubuntu font family (Canonical Ltd), packaged via Fontsource.
- License: Ubuntu Font Licence 1.0 (https://ubuntu.com/legal/font-licence).

## DM Sans font

- Paths: `packages/app-ui/src/fonts/dm-sans-latin-variable-{normal,italic}.woff2`
- Copyright: The DM Sans Project Authors.
- Source: https://github.com/googlefonts/dm-fonts
- License: SIL Open Font License 1.1; the full notice is in
  `packages/app-ui/src/fonts/DM-Sans-OFL.txt` and is included in packaged app resources.

## Whisper hallucination phrase list

- Path: `apps/desktop/src/main/infra/audio/hallucination-phrases.ts` (7422 normalized
  phrases used only as a filter word list for on-device transcription output).
- Source: derived from the Hugging Face dataset
  https://huggingface.co/datasets/sachaarbonel/whisper-hallucinations; see the dataset
  card for its terms.

## Provider logos

- Path: `apps/desktop/public/provider-logos/` — logos of AI and calendar providers
  (Anthropic, Apple, Cerebras, Cloudflare, Google, Groq, Ollama, OpenAI, OpenRouter,
  Vercel) shown next to the provider a user configures. These marks belong to their
  respective owners and are used nominatively; they are not covered by this repository's
  license.

## Patched npm dependencies

- `patches/macos-alias@0.2.12.patch` and `patches/fs-xattr@0.3.1.patch` add an install
  script so pnpm builds these MIT-licensed native bindings of the DMG maker; the packages
  themselves are unmodified otherwise and are build-time only.
