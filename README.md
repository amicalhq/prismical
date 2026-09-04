# Prismical Desktop

The open-source desktop app for [Prismical](https://prismical.ai): meeting notes with live
transcription, a rich-text editor and AI skills, for macOS (Apple silicon and Intel) and
Windows (x64). Built with Electron, React and Effect.

It runs in one of two modes, chosen on first launch:

- **Local mode** — no account. Notes live in a SQLite file on the machine, recording and
  transcription run on-device with [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
  (Metal on Apple silicon), meeting detection watches which app holds the microphone, and the
  AI skills (Enhance, Cleanup, Name note, Ask, custom skills) use a key you bring (OpenAI,
  Anthropic, OpenAI-compatible) or a local runtime such as Ollama. Nothing leaves the
  machine unless you configure a provider.
- **Cloud mode** — sign in to Prismical for sync across devices, sharing, organizations,
  calendar, managed models and true speaker diarization. Local transcription is available in
  cloud mode too.

Switching mode resets local data (there is no migration between the two).

## Download

Installers are attached to each [release](https://github.com/amicalhq/prismical/releases):
a `.dmg` for macOS and an `.exe` installer for Windows. Packaged builds update themselves.

## Repository layout

```
apps/desktop                      the Electron app (@prismical/desktop)
packages/desktop-contracts        IPC + window contracts shared by main, preload and renderer
packages/native-helpers/*         audio-capture (Swift / C#), mic-detector, eventkit helpers
packages/whisper-wrapper          the whisper.cpp N-API addon (+ whisper.cpp submodule and patches)
packages/webrtc-aec3-builder      reproducible build of the prebuilt WebRTC AEC3 bundle
packages/config-eslint, config-typescript   shared lint / tsconfig presets
packages/{app-ui,app-client,app-i18n,api-contracts,app-contracts,silence,
          editor-markdown,editor-schema,id,note-derive,ai-prompts}
                                  the screens, data layer, i18n catalogues and contracts
                                  shared with the Prismical web app
```

The desktop renders the same screens (`@prismical/app-ui`) over the same data layer
(`@prismical/app-client`) as the Prismical web app; platform differences go through the ports
seam in `apps/desktop/src/renderer/main/app/ports/`.

## Local development

### Prerequisites

- Node.js 24 and pnpm 10.27.0 (`corepack enable` picks the pinned version)
- CMake 3.20 or later (the whisper addon builds with cmake-js)
- **macOS:** Xcode or the Command Line Tools (Swift 5.10+). At runtime, local transcription
  needs macOS 14 or later (the whisper addon's deployment target) and capturing other
  participants' system audio needs macOS 14.2 or later.
- **Windows:** Visual Studio 2022 Build Tools with the *Desktop development with C++*
  workload, and the .NET 8 SDK for the recording helpers.

### Set up

Clone with the whisper.cpp submodule so the local-transcription addon can build:

```bash
git clone --recurse-submodules https://github.com/amicalhq/prismical.git
cd prismical
corepack enable
pnpm install            # applies the whisper.cpp patches and compiles the addon (a few minutes)
pnpm build              # builds the workspace packages the app imports from dist/
```

If you cloned without `--recurse-submodules`, `pnpm install` still succeeds but skips the
addon; run `pnpm --filter @prismical/whisper-wrapper dev:prepare` (initializes the submodule and
applies the patches) and then `pnpm install` again. Seeing the submodule marked as modified in
`git status` afterwards is expected — that is the applied patch.

### Run the app

```bash
cd apps/desktop
pnpm dev
```

Pick **Local** in the first-run chooser and nothing else is needed. The first recording
downloads a whisper model and the Silero VAD weights into the app's model directory (verified
against pinned checksums). Quit any installed copy of Prismical first: the dev app is a
separate Electron instance and shows up as "Electron" in the Dock.

Cloud mode against a Prismical backend needs `PRISMICAL_CLIENT_ID` (the public PKCE OAuth
client id registered on that backend) and, for a self-hosted or dev backend, the endpoint
overrides — copy `apps/desktop/.env.example` to `apps/desktop/.env`. Dev builds default to a
local `*.localhost` stack; packaged builds default to the public Prismical cloud. `pnpm dev`
adds a trusted dev-proxy CA (`~/.portless/ca.pem`) to Node only when that file exists; set
`NODE_EXTRA_CA_CERTS` yourself for any other self-signed dev stack.

### Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `PRISMICAL_CLIENT_ID` | build + runtime | Public OAuth client id for cloud-mode sign-in. Absent ⇒ sign-in reports "not configured". |
| `PRISMICAL_ANALYTICS_KEY` | build + runtime | Telemetry (PostHog) ingestion key. Absent ⇒ telemetry disabled. Local mode never identifies a user. |
| `PRISMICAL_CORE_API_URL`, `PRISMICAL_NOTE_WS_URL`, `PRISMICAL_WEB_APP_ORIGIN`, `PRISMICAL_ANALYTICS_HOST` | runtime | Cloud endpoints and the telemetry host (dev overrides). The core URL is also the auto-update feed. |
| `PRISMICAL_*_DEFAULT` | build | Packaged-build endpoint defaults (`core.prismical.ai` etc.). |
| `SKIP_CODESIGNING`, `CODESIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` | packaging | macOS signing + notarization; signing runs only when `SKIP_CODESIGNING=false`. |
| `WINDOWS_SIGNTOOL_PATH`, `WINDOWS_SIGN_WITH_PARAMS` | packaging (CI) | Squirrel in-releasify signing with Azure Trusted Signing. |
| `GGML_NATIVE`, `WHISPER_TARGETS`, `GGML_CUDA`, `GGML_VULKAN` | whisper build | Addon variants; see `packages/whisper-wrapper/README.md`. |
| `PRISMICAL_E2E*`, `PRISMICAL_E2E_TARGET`, `PRISMICAL_E2E_PACKAGE` | tests | Playwright harness switches; scrubbed from production packages. |
| `PRISMICAL_MODEL_CACHE` | scripts | Where `pnpm --filter @prismical/desktop fetch-eval-model` caches verified weights (default `~/.cache/prismical/models`). |

### Checks

```bash
pnpm lint
pnpm type:check
pnpm test                                        # every workspace package, incl. the desktop unit suite
pnpm --filter @prismical/desktop test:e2e:fresh  # packages an E2E-gated app and runs the Playwright suite
pnpm --filter @prismical/desktop exec vitest run tests/native   # helper golden fixtures + handshakes
pnpm --filter @prismical/desktop test:local-asr  # whisper end to end; first: pnpm --filter @prismical/desktop fetch-eval-model --model whisper-base-en (and --model silero-vad-v5)
```

### Packaging

```bash
cd apps/desktop
pnpm package        # out/Prismical-<platform>-<arch>/ (unsigned unless SKIP_CODESIGNING=false)
pnpm make           # DMG + ZIP (macOS) or a Squirrel .exe installer (Windows)
```

`build:deps` runs before every dev/package/make and rebuilds the native helpers only when their
sources changed; forge's `prePackage` hook builds the whisper addon if the submodule is present
and downloads the Node sidecar the transcription worker runs under. The prebuilt WebRTC AEC3
bundle is committed; rebuilding it is optional
(`packages/webrtc-aec3-builder/README.md`).

## Releasing

Maintainers release with the bumpp flow: `pnpm --filter @prismical/desktop exec bumpp <version>`
bumps `apps/desktop/package.json`, commits `chore: release v<version>` and pushes the
`v<version>` tag. That tag runs `.github/workflows/release.yml`: signed + notarized macOS
builds (arm64, x64) and a Trusted-Signed Windows x64 build, then attaches the installers and
auto-update payloads to a **draft** GitHub Release with a generated changelog. A push to a
`preview/**` branch produces an unsigned rolling pre-release instead. The workflow header lists
the repository secrets a signed release needs.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bugs and ideas go to the
[issue tracker](https://github.com/amicalhq/prismical/issues).

## License

[MIT](./LICENSE). Third-party components and model weights are listed in
[NOTICE.md](./NOTICE.md).
