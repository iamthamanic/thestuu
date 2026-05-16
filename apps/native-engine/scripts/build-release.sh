#!/usr/bin/env bash
# Release build for thestuu-native (CMake + Tracktion third-party path).
# Invoked from package.json "build" so package.json stays strict JSON for tooling.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${NATIVE_ROOT}"

export STUU_THIRD_PARTY_DIR="${STUU_THIRD_PARTY_DIR:-${STUU_NATIVE_VENDOR_DIR:-../../vendor/tracktion_engine}}"

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSTUU_THIRD_PARTY_DIR="${STUU_THIRD_PARTY_DIR}"
cmake --build build --target thestuu-native --config Release
