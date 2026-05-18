#!/usr/bin/env bash
#
# Release build for thestuu-native: CMake Release + LTO, then strip with split debug symbols.
# Output (gitignored): apps/native-engine/build-release/thestuu-native
# Invoked via: npm run build:release --workspace @thestuu/native-engine
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${NATIVE_ROOT}"

BUILD_DIR="${STUU_NATIVE_RELEASE_BUILD_DIR:-build-release}"
VENDOR="${STUU_THIRD_PARTY_DIR:-${STUU_NATIVE_VENDOR_DIR:-../../vendor/tracktion_engine}}"
VENDOR="$(cd "${NATIVE_ROOT}" && cd "${VENDOR}" 2>/dev/null && pwd || echo "${VENDOR}")"

if [[ ! -f "${VENDOR}/CMakeLists.txt" ]]; then
  echo "[thestuu-native] STUU_THIRD_PARTY_DIR / STUU_NATIVE_VENDOR_DIR must point at tracktion_engine." >&2
  echo "  Run: ./scripts/setup-tracktion.sh  (from repo root)" >&2
  exit 1
fi

human_size() {
  if [[ -f "$1" ]]; then
    stat -f '%z bytes (%N)' "$1" 2>/dev/null || stat -c '%s bytes (%n)' "$1"
  else
    echo "missing: $1"
  fi
}

echo "[thestuu-native] configuring Release + LTO in ${BUILD_DIR}/"
cmake -S . -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON \
  -DSTUU_THIRD_PARTY_DIR="${VENDOR}"

echo "[thestuu-native] building target thestuu-native"
cmake --build "${BUILD_DIR}" --target thestuu-native --config Release -j "$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"

resolve_built_binary() {
  local candidates=(
    "${BUILD_DIR}/thestuu-native"
    "${BUILD_DIR}/Release/thestuu-native"
    "${BUILD_DIR}/Release/thestuu-native.exe"
    "${BUILD_DIR}/thestuu-native.exe"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -f "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

BIN="$(resolve_built_binary)" || {
  echo "[thestuu-native] built binary not found under ${BUILD_DIR}" >&2
  exit 1
}

# Normalize to build-release/thestuu-native for Tauri externalBin (single path on all platforms).
DIST_BIN="${BUILD_DIR}/thestuu-native"
if [[ "$BIN" != "$DIST_BIN" ]]; then
  cp -f "$BIN" "${DIST_BIN}"
  BIN="${DIST_BIN}"
fi
chmod +x "${BIN}"

UNSTRIPPED="${BUILD_DIR}/thestuu-native.unstripped"
cp -f "${BIN}" "${UNSTRIPPED}"
echo "[thestuu-native] release (pre-strip): $(human_size "${BIN}")"

bash "${SCRIPT_DIR}/strip-native-binary.sh" "${BIN}" "${BUILD_DIR}"

echo ""
echo "[thestuu-native] release build complete"
echo "  distributable: ${BIN}"
echo "  pre-strip copy: ${UNSTRIPPED}"
if [[ "$(uname -s)" == Darwin && -d "${BUILD_DIR}/thestuu-native.dSYM" ]]; then
  echo "  debug symbols: ${BUILD_DIR}/thestuu-native.dSYM"
elif [[ -f "${BUILD_DIR}/thestuu-native.debug" ]]; then
  echo "  debug symbols: ${BUILD_DIR}/thestuu-native.debug"
fi
echo "  stripped size:    $(human_size "${BIN}")"
echo "  unstripped size:  $(human_size "${UNSTRIPPED}")"
echo ""
echo "Tauri: npm run build:native-release (repo root) then npm run desktop:build"
