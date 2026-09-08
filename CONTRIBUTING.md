# Contributing to Prismical Desktop

Thanks for helping. This file covers how the repository is put together and what a pull
request needs; the README covers setup.

## Where things live

- `apps/desktop` — the Electron app. `src/main` (Effect services, IPC, native helper hosts,
  the local data plane, transcription and AI providers), `src/preload`, `src/renderer` (the
  main, widget, float and notify windows), `e2e` (Playwright, packaged or bundle target) and
  `tests` (vitest).
- `packages/desktop-contracts` — IPC channel and window contracts (zod). Change these with the
  main-process handlers and the preload buffers together; `tests/contracts` pins the surface.
- `packages/native-helpers/*` — Swift (macOS) and C# (Windows) helper processes with a
  line-delimited JSON wire protocol; golden fixtures live in `apps/desktop/tests/native`.
- `packages/whisper-wrapper` — the whisper.cpp addon. Upstream changes go in as `.patch` files
  under `patches/` (applied by `preinstall`); bump the submodule pin and
  `WHISPER_CPP_VERSION` together.
- The shared packages (`packages/{app-ui,app-client,app-i18n,api-contracts,app-contracts,
silence,editor-markdown,editor-schema,id,note-derive,ai-prompts}`) — the screens, data layer,
  i18n catalogues and contract packages shared with the Prismical web app. They are updated
  here in batches; a pull request that changes one of them is welcome, and the maintainers
  carry the change across to the web app. New user-visible strings in the desktop are checked
  by the `@prismical/app-i18n` source-coverage test.

## Conventions

- TypeScript 5.8 with the shared presets in `packages/config-typescript`; the
  `prismical-source` export condition lets `tsc` see package sources while Vite and vitest
  consume built `dist/` (run `pnpm build` after a shared-package update or a package change).
- Every renderer-graph package declares `"zod": "catalog:"` — a stray `^3` pin poisons the
  shared Vite chunk for everyone.
- Lint with `pnpm lint` (eslint 9, flat config from `packages/config-eslint`). Prettier's config
  is at the root; format the files you touch (`pnpm exec prettier --write <files>`) rather than
  the whole tree — not every inherited file is prettier-clean yet, and the shared packages
  are excluded.
- Main-process code is Effect: services are layers, errors are `Data.TaggedError`, nothing
  is `Effect.die`d for an expected failure. `apps/desktop/tests/static-gate.test.ts` enforces
  the rails.
- Playwright specs use `expect()` assertions only — never `if`/`else` around an assertion.
- Anything on the audio path (`src/main/domains/recording`, capture, the note-body relay)
  must be bounded work; do not put CRDT or editor logic in the main process.

## Development gotchas

- **The dev app is "Electron" in the macOS Dock, not "Prismical".** "Prismical" in Spotlight or
  the Dock is the installed build.
- **Blank renderer while the main-process log says `boot complete`** → open DevTools (⌘⌥I):
  `Cannot read properties of undefined (reading 'datetime')` means a `zod` v3 pin somewhere in
  the renderer graph. Vite keys bare imports by package name, so one package pinning `"zod": "^3"`
  poisons the shared chunk. Every renderer-graph package must use `"zod": "catalog:"`; after
  fixing, `rm -rf apps/desktop/node_modules/.vite` and restart.
- **Dev sign-in uses portless** (`https://prismical-desktop.localhost/oauth/callback`).
  `pnpm dev` starts Forge through portless, which assigns the loopback listener's `PORT`.
  Custom schemes cannot work unpackaged because every Electron checkout shares the `com.github.Electron`
  bundle id; packaged builds use `prismical://`.
- **Sign-in fails `invalid_redirect`** → the loopback URI is missing from the OAuth client's
  redirect allow-list on the backend you sign in against.
- **Sign-in returns to the app, then bounces back to the gate** with
  `oauth exchange failed { reason: 'network' }` → check the backend connection and certificate
  chain. Startup adds OS-trusted certificates to Node's defaults; use `NODE_EXTRA_CA_CERTS`
  for a dev CA that is not installed in the OS trust store.
- **"Microphone access was denied"** → grant Microphone to **Electron** in System Settings →
  Privacy & Security.
- **Second launch silently exits** → single-instance lock: `pkill -f "electron-forge start"`.
- **No local transcription after a plain clone** → the whisper.cpp submodule was absent when
  `pnpm install` ran: `pnpm --filter @prismical/whisper-wrapper dev:prepare && pnpm install`.
- **Stale `dist/` after a shared-package update** → `pnpm build`.
- Renderer edits hot-reload; main-process edits need a full restart.

## Before you open a pull request

```bash
pnpm lint && pnpm type:check && pnpm test
pnpm --filter @prismical/desktop test:e2e:fresh     # when you touched main/preload/renderer wiring
```

CI runs lint, type-check and the unit tests, a bundle-target smoke spec
(the real main/preload/renderer booted on an isolated profile), the native helper builds on macOS
and Windows, and a whisper addon build from the submodule. The packaged `test:e2e:fresh` suite is
NOT run in CI — run it locally when you touch main/preload/renderer wiring. Native helper changes
need a build on the target platform; the Windows helpers can be exercised through CI if you have
no Windows machine.

## Commits and pull requests

- Conventional commits (`feat(desktop): …`, `fix(whisper): …`, `chore: …`); the release
  changelog is generated from them.
- One logical change per pull request, with the tests that prove it.
- No AI co-author trailers in commit messages.

## Security

Report vulnerabilities privately through a GitHub security advisory on this repository rather
than in a public issue.
Third-party components and their licenses are recorded in `NOTICE.md`.
