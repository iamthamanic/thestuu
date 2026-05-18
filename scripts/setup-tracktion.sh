#!/usr/bin/env bash
#
# TheStuu — readable multi-line setup script (bash -n scripts/setup-tracktion.sh).
# Clone Tracktion Engine into vendor/ and initialize the JUCE submodule.
#
# Usage (from repo root):
#   bash scripts/setup-tracktion.sh
#
# Then:
#   export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"
#   npm run dev

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="${VENDOR_DIR:-$REPO_ROOT/vendor}"
TRACKTION_DIR="$VENDOR_DIR/tracktion_engine"
TRACKTION_REPO="https://github.com/Tracktion/tracktion_engine.git"
JUCE_SUBMODULE_URL="https://github.com/juce-framework/JUCE.git"

echo "[thestuu] Vendor directory: $VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
cd "$VENDOR_DIR"

configure_juce_submodule() {
  git config -f .gitmodules submodule.modules/juce.url "$JUCE_SUBMODULE_URL"
  git submodule sync
  git submodule update --init --recursive
}

if [ -d "$TRACKTION_DIR/.git" ]; then
  echo "[thestuu] tracktion_engine already cloned — updating submodules..."
  cd "$TRACKTION_DIR"
  git submodule update --init --recursive
  cd "$VENDOR_DIR"
else
  echo "[thestuu] Cloning Tracktion Engine (with JUCE submodule)..."
  git clone "$TRACKTION_REPO" tracktion_engine
  cd "$TRACKTION_DIR"

  # Use HTTPS for JUCE (SSH submodule URLs fail without GitHub keys).
  configure_juce_submodule

  cd "$VENDOR_DIR"
fi

echo ""
echo "[thestuu] Tracktion Engine ready at: $TRACKTION_DIR"
echo ""
echo "Start the app from your project root with:"
echo "  export STUU_NATIVE_VENDOR_DIR=\"$TRACKTION_DIR\""
echo "  npm run dev"
echo ""
echo "Or as a one-liner:"
echo "  STUU_NATIVE_VENDOR_DIR=\"$TRACKTION_DIR\" npm run dev"
