#!/usr/bin/env bash
#
# Report dev vs release vs stripped native binary sizes (bytes + human).
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

human() {
  local path="$1"
  local label="$2"
  if [[ -f "$path" ]]; then
    local bytes
    bytes="$(wc -c <"$path" | tr -d ' ')"
    printf '%-28s %12s bytes  (%s)\n' "$label" "$bytes" "$path"
  else
    printf '%-28s %12s\n' "$label" "(not built)"
  fi
}

DEV="${NATIVE_ROOT}/build/thestuu-native"
RELEASE_UNSTRIPPED="${NATIVE_ROOT}/build-release/thestuu-native.unstripped"
RELEASE_STRIPPED="${NATIVE_ROOT}/build-release/thestuu-native"

echo "thestuu-native binary sizes"
echo "----------------------------"
human "$DEV" "dev (build/)"
human "$RELEASE_UNSTRIPPED" "release pre-strip"
human "$RELEASE_STRIPPED" "release stripped"
