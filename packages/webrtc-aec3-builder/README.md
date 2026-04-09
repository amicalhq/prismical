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
4. Generates `arm64` and `x86_64` macOS build files.
5. Builds a complete static library target for each architecture.
6. Produces the vendored bundle consumed by
   `packages/native-helpers/audio-capture`.

## Commands

- `pnpm --filter @prismical/webrtc-aec3-builder doctor:env`
- `pnpm --filter @prismical/webrtc-aec3-builder fetch`
- `pnpm --filter @prismical/webrtc-aec3-builder gen:arm64`
- `pnpm --filter @prismical/webrtc-aec3-builder gen:x64`
- `pnpm --filter @prismical/webrtc-aec3-builder build:arm64`
- `pnpm --filter @prismical/webrtc-aec3-builder build:x64`
- `pnpm --filter @prismical/webrtc-aec3-builder bundle`
- `pnpm --filter @prismical/webrtc-aec3-builder build:bundle`

`build:bundle` is the end-to-end path once your machine has the required build
toolchain.

## Output

The final vendored bundle is written to:

- `packages/native-helpers/audio-capture/Vendor/WebRTC/macOS/lib/libprismical_webrtc_aec3.a`
- `packages/native-helpers/audio-capture/Vendor/WebRTC/macOS/include/prismical_aec3.h`
- `packages/native-helpers/audio-capture/Vendor/WebRTC/macOS/BUILD_INFO.txt`

That output is what the native helper links when present.
