#!/usr/bin/env bash
# Klont Tracktion Engine in ein vendor-Verzeichnis und setzt STUU_NATIVE_VENDOR_DIR.
# Danach: export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine" und npm run dev.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="${VENDOR_DIR:-$REPO_ROOT/vendor}"
TRACKTION_DIR="$VENDOR_DIR/tracktion_engine"

echo "[thestuu] Vendor directory: $VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
cd "$VENDOR_DIR"

if [ -d "$TRACKTION_DIR/.git" ]; then
  echo "[thestuu] tracktion_engine already cloned. Updating submodules..."
  cd "$TRACKTION_DIR"
  git submodule update --init --recursive
  cd "$VENDOR_DIR"
else
  echo "[thestuu] Cloning Tracktion Engine (with JUCE submodule)..."
  git clone --recurse-submodules https://github.com/Tracktion/tracktion_engine.git
fi

echo ""
echo "[thestuu] Tracktion Engine ready at: $TRACKTION_DIR"
echo ""
echo "Start the app from your project root (thestuu folder) with:"
echo "  export STUU_NATIVE_VENDOR_DIR=\"$TRACKTION_DIR\""
echo "  npm run dev"
echo ""
echo "Or one-liner:"
echo "  STUU_NATIVE_VENDOR_DIR=\"$TRACKTION_DIR\" npm run dev"
