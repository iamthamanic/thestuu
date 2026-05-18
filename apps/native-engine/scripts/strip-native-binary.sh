#!/usr/bin/env bash
#
# Strip debug symbols from thestuu-native for distribution; keep separate debug symbols.
# Called from scripts/build-release.sh — do not commit outputs.
#
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: strip-native-binary.sh <path-to-thestuu-native> [output-dir]" >&2
  exit 1
fi

BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT_DIR="${2:-$(dirname "$BIN")}"

if [[ ! -f "$BIN" ]]; then
  echo "[thestuu-native] strip: binary not found: $BIN" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

case "$(uname -s)" in
  Darwin)
    DSYM="${OUT_DIR}/thestuu-native.dSYM"
    rm -rf "$DSYM"
    echo "[thestuu-native] generating dSYM at ${DSYM}"
    dsymutil "$BIN" -o "$DSYM"
    echo "[thestuu-native] stripping executable (debug info in dSYM)"
    strip -x "$BIN"
    ;;
  Linux)
    DEBUG_FILE="${OUT_DIR}/thestuu-native.debug"
    echo "[thestuu-native] extracting debug symbols to ${DEBUG_FILE}"
    objcopy --only-keep-debug "$BIN" "$DEBUG_FILE"
    chmod 644 "$DEBUG_FILE"
    echo "[thestuu-native] stripping executable"
    strip --strip-unneeded "$BIN"
    echo "[thestuu-native] linking debug file"
    objcopy --add-gnu-debuglink="$DEBUG_FILE" "$BIN"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows*)
    PDB="${OUT_DIR}/thestuu-native.pdb"
    if command -v llvm-strip >/dev/null 2>&1; then
      echo "[thestuu-native] llvm-strip (PDB retention depends on linker; see docs/native-engine-release.md)"
      llvm-strip --strip-debug "$BIN"
    else
      echo "[thestuu-native] strip skipped on Windows (install llvm-strip or use MSVC /DEBUG:FULL + pdbcopy)"
    fi
    ;;
  *)
    echo "[thestuu-native] unknown platform; skipping strip" >&2
    exit 1
    ;;
esac

echo "[thestuu-native] strip complete: $BIN"
