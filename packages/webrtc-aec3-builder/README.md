# @prismical/webrtc-aec3-builder

This workspace package owns the source-build flow for Prismical's WebRTC AEC3
vendor bundle.

It intentionally keeps the heavy Google WebRTC checkout out of the normal app
repo tree. Local state lives under `.local/`, which is already gitignored by the
workspace root.

## What it does

1. Bootstraps `depot_tools` locally if needed.
2. Fetches a pinned WebRTC checkout from the official upstream source tree.
3. Syncs a tiny Prismical GN overlay into the checkout.
4. Generates macOS or Windows build files.
5. Builds a complete native WebRTC AEC3 bridge target.
6. Produces vendored bundles consumed by
   `packages/native-helpers/audio-capture`.

## Commands

- `pnpm --filter @prismical/webrtc-aec3-builder doctor:env`
- `pnpm --filter @prismical/webrtc-aec3-builder fetch`
- `pnpm --filter @prismical/webrtc-aec3-builder gen:arm64`
- `pnpm --filter @prismical/webrtc-aec3-builder gen:x64`
- `pnpm --filter @prismical/webrtc-aec3-builder gen:win-x64`
- `pnpm --filter @prismical/webrtc-aec3-builder build:arm64`
- `pnpm --filter @prismical/webrtc-aec3-builder build:x64`
- `pnpm --filter @prismical/webrtc-aec3-builder build:win-x64`
- `pnpm --filter @prismical/webrtc-aec3-builder bundle`
- `pnpm --filter @prismical/webrtc-aec3-builder bundle:win-x64`
- `pnpm --filter @prismical/webrtc-aec3-builder build:bundle`
- `pnpm --filter @prismical/webrtc-aec3-builder build:windows`

`build:bundle` is the end-to-end path once your machine has the required build
toolchain for macOS. `build:windows` is the end-to-end path for the Windows
`x64` DLL.

On Windows, run the commands from a Visual Studio 2022 Developer PowerShell or
Developer Command Prompt so `cl.exe` is available. `depot_tools`, `gn`, and
`autoninja` are bootstrapped into `.local/` by `fetch`.

## Output

The final vendored bundle is written to:

- `packages/native-helpers/audio-capture/Vendor/WebRTC/macOS/lib/libprismical_webrtc_aec3.a`
- `packages/native-helpers/audio-capture/Vendor/WebRTC/macOS/include/prismical_aec3.h`
- `packages/native-helpers/audio-capture/Vendor/WebRTC/macOS/BUILD_INFO.txt`
- `packages/native-helpers/audio-capture/Vendor/WebRTC/windows/x64/bin/prismical_webrtc_aec3.dll`
- `packages/native-helpers/audio-capture/Vendor/WebRTC/windows/x64/lib/prismical_webrtc_aec3.lib`
- `packages/native-helpers/audio-capture/Vendor/WebRTC/windows/include/prismical_aec3.h`
- `packages/native-helpers/audio-capture/Vendor/WebRTC/windows/x64/BUILD_INFO.txt`

The macOS helper links the static archive when present. The Windows helper
loads the DLL at runtime when present and falls back to the reference reducer
when it is missing.
