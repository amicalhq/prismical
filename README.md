<!-- Markdown with HTML -->
<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://prismical.ai/github-readme-header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://prismical.ai/github-readme-header-light.png">
  <img alt="Prismical" src="https://prismical.ai/github-readme-header-light.png">
</picture>
</div>

<p align="center">
  <a href='http://makeapullrequest.com'>
    <img alt='PRs Welcome' src='https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=shields'/>
  </a>
  <a href="https://opensource.org/license/MIT/">
    <img src="https://img.shields.io/github/license/amicalhq/prismical?logo=opensourceinitiative&logoColor=white&label=License&color=8A2BE2" alt="license">
  </a>
  <br>
  <a href="https://prismical.ai/community">
    <img src="https://img.shields.io/badge/discord-7289da.svg?style=flat-square&logo=discord" alt="discord" style="height: 20px;">
  </a>
</p>

<p align="center">
  <a href="https://prismical.ai">Website</a> - <a href="https://prismical.ai/docs">Docs</a> - <a href="https://prismical.ai/community">Community</a> - <a href="https://github.com/amicalhq/prismical/issues/new?assignees=&labels=bug&template=bug_report.md">Bug reports</a>
</p>

## Table of Contents

- [⬇️ Download](#️-download)
- [🔮 Overview](#-overview)
- [✨ Features](#-features)
- [🔰 Tech Stack](#-tech-stack)
- [🛠 Development](#-development)
- [🤗 Contributing](#-contributing)
- [🎗 License](#-license)

## ⬇️ Download

<p>
  <a href="https://github.com/amicalhq/prismical/releases/latest">
    <img src="https://prismical.ai/download_button_macos.png" alt="Download for macOS" height="60">
  </a>
  <a href="https://github.com/amicalhq/prismical/releases/latest">
    <img src="https://prismical.ai/download_button_windows.png" alt="Download for Windows" height="60">
  </a>
</p>

<p>
  <a href="https://apps.apple.com/us/app/prismical-ai-note-taker/id6780624498">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://prismical.ai/badges/app-store-on-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://prismical.ai/badges/app-store-on-light.svg">
      <img alt="Download on the App Store" src="https://prismical.ai/badges/app-store-on-light.svg" height="60">
    </picture>
  </a>
  <a href="https://play.google.com/store/apps/details?id=ai.prismical.app">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://prismical.ai/badges/google-play-on-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://prismical.ai/badges/google-play-on-light.svg">
      <img alt="Get it on Google Play" src="https://prismical.ai/badges/google-play-on-light.svg" height="60">
    </picture>
  </a>
</p>

Desktop installers are attached to each [release](https://github.com/amicalhq/prismical/releases):
[macOS (Apple silicon)](https://github.com/amicalhq/prismical/releases/latest/download/Prismical-macos-arm64.dmg),
[macOS (Intel)](https://github.com/amicalhq/prismical/releases/latest/download/Prismical-macos-x64.dmg) and
[Windows (x64)](https://github.com/amicalhq/prismical/releases/latest/download/Prismical-windows-x64.exe).
Packaged builds update themselves.

## 🔮 Overview

Open-source AI note taker.

Prismical is a free, open-source AI note taker that transcribes meetings, lectures and voice notes — without a bot joining your call. It captures system audio in the background, transcribes it with local or cloud AI, and turns it into structured notes with key decisions and action items.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://prismical.ai/screenshots/hero-dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="https://prismical.ai/screenshots/hero-light.webp">
  <img alt="Prismical desktop app home screen with upcoming meetings and recent notes" src="https://prismical.ai/screenshots/hero-light.webp">
</picture>

Works with Zoom, Google Meet, Microsoft Teams, Slack, WebEx — anything that plays audio. Not in a meeting? Just talk or type. Prismical captures and enhances your voice notes too.

This repository is the Prismical desktop app for macOS (Apple silicon and Intel) and Windows (x64).

## ✨ Features

🎙️ Real-time meeting transcription — system audio capture, no bot joins your call

🧠 AI summaries & action items — structured notes with key decisions and follow-ups

🗣️ Voice notes — talk or type, AI structures and organizes your thoughts

🪄 AI skills — Enhance, Cleanup and Ask across your notes, or write your own custom skills

🔐 Local-first AI — on-device transcription with whisper.cpp

🔑 Bring your own model — OpenAI, Anthropic, OpenRouter, any OpenAI-compatible endpoint, or local models with Ollama

📅 Meeting detection — Prismical notices when a meeting app starts using the microphone

🪟 Floating widget — always-on-top compact window for live transcripts and quick notes

🔍 Full-text search across all meetings, notes and transcripts

☁️ Prismical cloud (optional) — sync across devices, sharing, organizations, calendar and speaker diarization

🔌 MCP server — connect your notes to Claude, ChatGPT, Gemini and more (with a Prismical account)

📱 iOS & Android apps — on the App Store and Google Play

## 🔰 Tech Stack

- 🖥️ [Electron](https://electronjs.org/)
- ⚛️ [React](https://react.dev/)
- 🧑‍💻 [TypeScript](https://www.typescriptlang.org/)
- 🌊 [Effect](https://effect.website/)
- 🎤 [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
- 🦙 [Ollama](https://ollama.ai)
- 🧭 [TanStack Router](https://tanstack.com/router) & [Query](https://tanstack.com/query)
- ✍️ [Tiptap](https://tiptap.dev/)
- 🗄️ [SQLite](https://sqlite.org/) & [Drizzle](https://orm.drizzle.team/)
- 🎨 [Tailwind CSS](https://tailwindcss.com/)
- 🧑🏼‍🎨 [shadcn/ui](https://ui.shadcn.com/)
- 🧘‍♂️ [Zod](https://zod.dev/)
- 🧪 [Vitest](https://vitest.dev/) & [Playwright](https://playwright.dev/)
- 🌀 [Turborepo](https://turbo.build/)

## 🛠 Development

### Repository layout

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
```

### Local development

#### Prerequisites

- Node.js 24 and pnpm 10.27.0 (`corepack enable` picks the pinned version)
- Portless 0.5 or later (`npm install -g portless`), with its HTTPS proxy on port 443
  and local CA trusted (`portless proxy start --https` and `portless trust`)
- CMake 3.20 or later (the whisper addon builds with cmake-js)
- **macOS:** Xcode or the Command Line Tools (Swift 5.10+). At runtime, local transcription
  needs macOS 14 or later (the whisper addon's deployment target) and capturing other
  participants' system audio needs macOS 14.2 or later.
- **Windows:** Visual Studio 2022 Build Tools with the *Desktop development with C++*
  workload, and the .NET 8 SDK for the recording helpers.

#### Set up

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

#### Run the app

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
starts a persistent Forge runner through portless, which assigns the internal OAuth listener port.
In-app restarts recreate Forge and Vite while retaining that route; a normal quit stops the runner.
Register `https://prismical-desktop.localhost/oauth/callback` on the backend's OAuth client;
the internal port does not appear in the redirect URI. The launcher also
adds a trusted dev-proxy CA (`~/.portless/ca.pem`) to Node only when that file exists; set
`NODE_EXTRA_CA_CERTS` yourself for any other self-signed dev stack. At startup, the app also
adds OS-trusted certificates to Node's defaults, excluding expired or invalid certificates.

#### Environment variables

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

#### Checks

```bash
pnpm lint
pnpm type:check
pnpm test                                        # every workspace package, incl. the desktop unit suite
pnpm --filter @prismical/desktop test:e2e:fresh  # packages an E2E-gated app and runs the Playwright suite
pnpm --filter @prismical/desktop exec vitest run tests/native   # helper golden fixtures + handshakes
pnpm --filter @prismical/desktop test:local-asr  # whisper end to end; first: pnpm --filter @prismical/desktop fetch-eval-model --model whisper-base-en (and --model silero-vad-v5)
```

#### Packaging

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

### Releasing

Maintainers release with the bumpp flow: `pnpm --filter @prismical/desktop exec bumpp <version>`
bumps `apps/desktop/package.json`, commits `chore: release v<version>` and pushes the
`v<version>` tag. That tag runs `.github/workflows/release.yml`: signed + notarized macOS
builds (arm64, x64) and a Trusted-Signed Windows x64 build, then attaches the installers and
auto-update payloads to a **draft** GitHub Release with a generated changelog. A push to a
`preview/**` branch produces an unsigned rolling pre-release instead. The workflow header lists
the repository secrets a signed release needs.

## 🤗 Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for how the repository is put together and what a pull request needs, or reach out to the team in our [Discord server](https://prismical.ai/community).

- **🐛 [Report an Issue][issues]**: Found a bug? Let us know!
- **💬 [Start a Discussion][discussions]**: Have ideas or suggestions? We'd love to hear from you.

## 🎗 License

Released under [MIT][license]. Third-party components and model weights are listed in [NOTICE.md](./NOTICE.md).

<!-- REFERENCE LINKS -->

[license]: https://github.com/amicalhq/prismical/blob/main/LICENSE
[discussions]: https://prismical.ai/community
[issues]: https://github.com/amicalhq/prismical/issues
[pulls]: https://github.com/amicalhq/prismical/pulls "submit a pull request"
