#!/usr/bin/env bash
#
# Dev/native CLI build into build/ (symbols retained; used by npm run start).
# For distributable/stripped binaries use scripts/build-release.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${NATIVE_ROOT}"

BUILD_DIR="${STUU_NATIVE_BUILD_DIR:-build}"
VENDOR="${STUU_THIRD_PARTY_DIR:-${STUU_NATIVE_VENDOR_DIR:-../../vendor/tracktion_engine}}"
VENDOR="$(cd "${NATIVE_ROOT}" && cd "${VENDOR}" 2>/dev/null && pwd || echo "${VENDOR}")"

if [[ ! -f "${VENDOR}/CMakeLists.txt" ]]; then
  echo "[thestuu-native] vendor not found at ${VENDOR}" >&2
  exit 1
fi

cmake -S . -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DSTUU_THIRD_PARTY_DIR="${VENDOR}"

cmake --build "${BUILD_DIR}" --target thestuu-native --config Release -j "$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"

echo "[thestuu-native] dev binary: ${BUILD_DIR}/thestuu-native"
