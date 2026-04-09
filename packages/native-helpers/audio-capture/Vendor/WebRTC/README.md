# WebRTC Vendor Bundle

Prismical's macOS meeting AEC path is designed to use Google's WebRTC audio
processing implementation through a small native bridge target.

This package currently ships a pass-through bridge implementation so the helper
and frame pipeline can compile before the real bundle is dropped in.

When the real bundle is present, SwiftPM detects it and stops compiling the
local stub implementation. The app then links the vendored static archive
instead.

## Intended Bundle Shape

Place a reproducible, pinned macOS bundle here:

- `macOS/lib/libprismical_webrtc_aec3.a`
- `macOS/include/prismical_aec3.h`
- `macOS/BUILD_INFO.txt`

The static library should be a universal or fat archive that contains both:

- `arm64`
- `x86_64`

The archive must export the C symbols declared in
`Sources/PrismicalAec3Bridge/include/prismical_aec3.h`. That keeps Prismical's
build independent from raw WebRTC headers and makes the vendored bundle a
drop-in replacement for the stub bridge.

## Source of Truth

The implementation should come from Google's WebRTC source tree, with the
needed audio-processing subset built ahead of time and committed or otherwise
managed in repo build flow.

Prismical should not depend on runtime downloads for this library.

## Bundle Packaging

The preferred path is the dedicated workspace package:

`pnpm --filter @prismical/webrtc-aec3-builder build:bundle`

That package:

- bootstraps `depot_tools`
- fetches a pinned official WebRTC checkout into local ignored state
- generates Prismical's GN overlay target
- builds `arm64` and `x86_64` archives
- writes the final universal bundle into `Vendor/WebRTC/macOS/`

There is also a lower-level helper script:

`packages/native-helpers/audio-capture/scripts/package-webrtc-aec3-bundle.sh`

That script is for manual packaging when you already have the per-architecture
static library inputs and a local WebRTC checkout.
