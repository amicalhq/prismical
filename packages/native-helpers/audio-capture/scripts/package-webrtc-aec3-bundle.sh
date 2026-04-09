#!/bin/zsh

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  package-webrtc-aec3-bundle.sh \
    --checkout /path/to/webrtc/src \
    --arm64-lib /path/to/arm64/lib1.a \
    --arm64-lib /path/to/arm64/lib2.a \
    --x64-lib /path/to/x64/lib1.a \
    --x64-lib /path/to/x64/lib2.a \
    [--include-dir /extra/include/path] \
    [--bundle-dir /custom/output/dir]

Builds Prismical's vendored WebRTC AEC bundle by compiling a tiny wrapper
against a local Google WebRTC checkout and merging that object with the
supplied per-architecture static libraries.
EOF
}

script_dir="$(cd "$(dirname "$0")" && pwd)"
package_root="$(cd "$script_dir/.." && pwd)"
checkout=""
bundle_dir="$package_root/Vendor/WebRTC/macOS"
typeset -a arm64_libs
typeset -a x64_libs
typeset -a include_dirs

while [[ $# -gt 0 ]]; do
  case "$1" in
    --checkout)
      checkout="$2"
      shift 2
      ;;
    --bundle-dir)
      bundle_dir="$2"
      shift 2
      ;;
    --arm64-lib)
      arm64_libs+=("$2")
      shift 2
      ;;
    --x64-lib)
      x64_libs+=("$2")
      shift 2
      ;;
    --include-dir)
      include_dirs+=("$2")
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$checkout" || ${#arm64_libs[@]} -eq 0 || ${#x64_libs[@]} -eq 0 ]]; then
  usage >&2
  exit 1
fi

vendor_source="$package_root/Vendor/WebRTC/shims/prismical_aec3_vendor.cpp"
public_header="$package_root/Sources/PrismicalAec3Bridge/include/prismical_aec3.h"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/prismical-webrtc-bundle.XXXXXX")"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

for required_path in "$checkout" "$vendor_source" "$public_header"; do
  if [[ ! -e "$required_path" ]]; then
    echo "Missing required path: $required_path" >&2
    exit 1
  fi
done

for lib_path in "${arm64_libs[@]}" "${x64_libs[@]}"; do
  if [[ ! -f "$lib_path" ]]; then
    echo "Missing static library: $lib_path" >&2
    exit 1
  fi
done

default_include_dirs=(
  "$package_root/Sources/PrismicalAec3Bridge/include"
  "$checkout"
  "$checkout/third_party/abseil-cpp"
)

compile_wrapper() {
  local arch="$1"
  local output="$2"
  local -a command=(
    clang++
    -std=c++17
    -O2
    -DNDEBUG
    -arch "$arch"
  )

  local include_dir
  for include_dir in "${default_include_dirs[@]}" "${include_dirs[@]}"; do
    command+=(-I "$include_dir")
  done

  command+=(
    -c "$vendor_source"
    -o "$output"
  )

  "${command[@]}"
}

mkdir -p "$tmp_dir/arm64" "$tmp_dir/x64" "$bundle_dir/lib" "$bundle_dir/include"

compile_wrapper "arm64" "$tmp_dir/arm64/prismical_aec3_vendor.o"
compile_wrapper "x86_64" "$tmp_dir/x64/prismical_aec3_vendor.o"

libtool -static \
  -o "$tmp_dir/arm64/libprismical_webrtc_aec3.a" \
  "$tmp_dir/arm64/prismical_aec3_vendor.o" \
  "${arm64_libs[@]}"

libtool -static \
  -o "$tmp_dir/x64/libprismical_webrtc_aec3.a" \
  "$tmp_dir/x64/prismical_aec3_vendor.o" \
  "${x64_libs[@]}"

lipo -create \
  "$tmp_dir/arm64/libprismical_webrtc_aec3.a" \
  "$tmp_dir/x64/libprismical_webrtc_aec3.a" \
  -output "$bundle_dir/lib/libprismical_webrtc_aec3.a"

cp "$public_header" "$bundle_dir/include/prismical_aec3.h"

checkout_revision="unknown"
if git -C "$checkout" rev-parse HEAD >/dev/null 2>&1; then
  checkout_revision="$(git -C "$checkout" rev-parse HEAD)"
fi

{
  echo "checkout=$checkout"
  echo "revision=$checkout_revision"
  echo "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "arm64_libs=${arm64_libs[*]}"
  echo "x64_libs=${x64_libs[*]}"
} > "$bundle_dir/BUILD_INFO.txt"

lipo -info "$bundle_dir/lib/libprismical_webrtc_aec3.a"

required_symbol='_(prismical_aec3_create|prismical_aec3_destroy|prismical_aec3_analyze_render|prismical_aec3_process_capture|prismical_aec3_reset|prismical_aec3_is_real)$'
if ! nm -gU "$bundle_dir/lib/libprismical_webrtc_aec3.a" | rg "$required_symbol" >/dev/null; then
  echo "Bundled archive does not export the expected prismical_aec3 symbols." >&2
  exit 1
fi

echo "Bundled WebRTC AEC archive written to $bundle_dir/lib/libprismical_webrtc_aec3.a"
