#!/usr/bin/env bash
# Kill stray prismical dev processes (Electron, whisper workers, mic-detector, turbo daemon).
# Scoped to processes whose command line contains "prismical" so it cannot affect other apps.
set -u

PATTERNS=(
  'prismical/.*node_modules/electron/dist/Electron\.app/Contents/.*/Electron'
  'prismical/.*\.vite/build/whisper-worker-fork\.js'
  'prismical/.*packages/native-helpers/mic-detector/bin/prismical-mic-detector'
  'prismical/.*node_modules/turbo-darwin-arm64/bin/turbo'
)

total=0
for pat in "${PATTERNS[@]}"; do
  pids=$(pgrep -f "$pat" || true)
  for pid in $pids; do
    if kill -9 "$pid" 2>/dev/null; then
      echo "  killed pid=$pid  [$pat]"
      total=$((total + 1))
    fi
  done
done

echo "Killed $total prismical process(es)."
