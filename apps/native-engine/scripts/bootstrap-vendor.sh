#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${1:-${NATIVE_ROOT}/vendor}"

JUCE_REF="${JUCE_REF:-develop}"
TRACKTION_REF="${TRACKTION_REF:-develop}"

JUCE_DIR="${VENDOR_DIR}/JUCE"
TRACKTION_DIR="${VENDOR_DIR}/tracktion_engine"

echo "[thestuu-native] vendor dir: ${VENDOR_DIR}"
mkdir -p "${VENDOR_DIR}"

if [[ -d "${JUCE_DIR}/.git" ]]; then
  echo "[thestuu-native] JUCE already present -> fetch ${JUCE_REF}"
  git -C "${JUCE_DIR}" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
  git -C "${JUCE_DIR}" fetch --tags --prune origin "${JUCE_REF}" || git -C "${JUCE_DIR}" fetch --tags --prune
  if git -C "${JUCE_DIR}" show-ref --verify --quiet "refs/remotes/origin/${JUCE_REF}"; then
    git -C "${JUCE_DIR}" checkout -B "${JUCE_REF}" "origin/${JUCE_REF}"
  else
    git -C "${JUCE_DIR}" checkout "${JUCE_REF}"
  fi
  git -C "${JUCE_DIR}" pull --ff-only || true
else
  echo "[thestuu-native] cloning JUCE (${JUCE_REF})"
  git clone --depth 1 --branch "${JUCE_REF}" https://github.com/juce-framework/JUCE.git "${JUCE_DIR}"
fi

if [[ -d "${TRACKTION_DIR}/.git" ]]; then
  echo "[thestuu-native] tracktion_engine already present -> fetch ${TRACKTION_REF}"
  git -C "${TRACKTION_DIR}" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
  git -C "${TRACKTION_DIR}" fetch --tags --prune origin "${TRACKTION_REF}" || git -C "${TRACKTION_DIR}" fetch --tags --prune
  if git -C "${TRACKTION_DIR}" show-ref --verify --quiet "refs/remotes/origin/${TRACKTION_REF}"; then
    git -C "${TRACKTION_DIR}" checkout -B "${TRACKTION_REF}" "origin/${TRACKTION_REF}"
  else
    git -C "${TRACKTION_DIR}" checkout "${TRACKTION_REF}"
  fi
  git -C "${TRACKTION_DIR}" pull --ff-only || true
else
  echo "[thestuu-native] cloning tracktion_engine (${TRACKTION_REF})"
  git clone --depth 1 --branch "${TRACKTION_REF}" https://github.com/Tracktion/tracktion_engine.git "${TRACKTION_DIR}"
fi

echo "[thestuu-native] vendor bootstrap complete"
