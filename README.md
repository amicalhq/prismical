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
  <a href="https://prismical.ai/beta">
    <img src="https://prismical.ai/mobile_beta_button.svg" alt="Apply for Mobile Beta" height="60">
  </a>
</p>

### Homebrew (macOS)

```bash
brew install --cask prismical
```

## 🔮 Overview

Open-source AI note taker.

Prismical is a free, open-source AI note-taker that transcribes meetings and captures voice notes — without a bot joining your call. It captures system audio in the background, processes it locally with AI, and gives you structured notes. No audio leaves your device unless you choose otherwise.

Powered by local AI models like [Whisper](https://github.com/openai/whisper) and [Parakeet](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/models.html#parakeet) for on-device transcription. Bring your own LLM for intelligent processing — run local models via [Ollama](https://ollama.ai), or connect cloud providers like OpenAI, Claude, and Gemini with your own API keys.

Works with Zoom, Google Meet, Microsoft Teams, Slack, WebEx — anything that plays audio. Not in a meeting? Just talk or type. Prismical captures and enhances your voice notes too.

## ✨ Features

🎙️ Real-time meeting transcription — system audio capture, no bot joins your call

🧠 AI summaries & action items — structured notes with key decisions and follow-ups

🗣️ Voice notes — talk or type, AI structures and organizes your thoughts

🔐 Local-first AI — on-device transcription with Whisper and Parakeet, no audio leaves your machine

☁️ BYOK cloud providers — optionally use OpenAI, Claude, or Gemini with your own keys

🪟 Floating widget — always-on-top compact window for live transcripts and quick notes

🔌 MCP server — connect Prismical to Claude, ChatGPT, Claude Code, and Codex

🔍 Full-text search across all meetings, notes, and transcripts

📱 iOS & Android mobile apps

## 🔰 Tech Stack

- 🎤 [Whisper](https://github.com/openai/whisper)
- 🦙 [Ollama](https://ollama.ai)
- 🧑‍💻 [Typescript](https://www.typescriptlang.org/)
- 🖥️ [Electron](https://electronjs.org/)
- ☘️ [Next.js](https://nextjs.org/)
- 🎨 [TailwindCSS](https://tailwindcss.com/)
- 🧑🏼‍🎨 [Shadcn](https://ui.shadcn.com/)
- 🔒 [Better-Auth](https://better-auth.com/)
- 🧘‍♂️ [Zod](https://zod.dev/)
- 🐞 [Jest](https://jestjs.io/)
- 📚 [Fumadocs](https://github.com/fuma-nama/fumadocs)
- 🌀 [Turborepo](https://turbo.build/)

## 🤗 Contributing

Contributions are welcome! Reach out to the team in our [Discord server](https://prismical.ai/community) to learn more.

- **🐛 [Report an Issue][issues]**: Found a bug? Let us know!
- **💬 [Start a Discussion][discussions]**: Have ideas or suggestions? We'd love to hear from you.

## 🎗 License

Released under [MIT][license].

<!-- REFERENCE LINKS -->

[license]: https://github.com/amicalhq/prismical/blob/main/LICENSE
[discussions]: https://prismical.ai/community
[issues]: https://github.com/amicalhq/prismical/issues
[pulls]: https://github.com/amicalhq/prismical/pulls "submit a pull request"
