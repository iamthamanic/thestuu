#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${1:-${NATIVE_ROOT}/vendor}"

DEFAULT_JUCE_REF="75fee9639a855a1b0c8b2b3e2cb9265d9bcaaf4d"
DEFAULT_TRACKTION_REF="2877b621f2fbee564d0696a616b86bf8ba8c8ab0"

JUCE_REF="${JUCE_REF:-${DEFAULT_JUCE_REF}}"
TRACKTION_REF="${TRACKTION_REF:-${DEFAULT_TRACKTION_REF}}"

JUCE_DIR="${VENDOR_DIR}/JUCE"
TRACKTION_DIR="${VENDOR_DIR}/tracktion_engine"

is_commit_hash() {
  [[ "${1}" =~ ^[0-9a-f]{40}$ ]]
}

checkout_repo_ref() {
  local repo_dir="$1"
  local repo_name="$2"
  local ref="$3"

  echo "[thestuu-native] ${repo_name}: sync ref ${ref}"
  git -C "${repo_dir}" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
  git -C "${repo_dir}" fetch --tags --prune origin

  if is_commit_hash "${ref}"; then
    git -C "${repo_dir}" fetch --depth 1 origin "${ref}"
    git -C "${repo_dir}" checkout --detach FETCH_HEAD
    return
  fi

  if git -C "${repo_dir}" show-ref --verify --quiet "refs/remotes/origin/${ref}"; then
    git -C "${repo_dir}" checkout -B "${ref}" "origin/${ref}"
    git -C "${repo_dir}" pull --ff-only || true
    return
  fi

  if git -C "${repo_dir}" rev-parse --verify --quiet "refs/tags/${ref}" >/dev/null; then
    git -C "${repo_dir}" checkout "tags/${ref}"
    return
  fi

  git -C "${repo_dir}" checkout "${ref}"
}

clone_repo() {
  local repo_name="$1"
  local repo_url="$2"
  local repo_dir="$3"
  local ref="$4"

  if is_commit_hash "${ref}"; then
    echo "[thestuu-native] cloning ${repo_name} (commit ${ref})"
    git clone "${repo_url}" "${repo_dir}"
    checkout_repo_ref "${repo_dir}" "${repo_name}" "${ref}"
    return
  fi

  echo "[thestuu-native] cloning ${repo_name} (${ref})"
  if git clone --depth 1 --branch "${ref}" "${repo_url}" "${repo_dir}"; then
    return
  fi

  echo "[thestuu-native] ${repo_name}: depth-1 clone for '${ref}' failed, falling back to full clone"
  git clone "${repo_url}" "${repo_dir}"
  checkout_repo_ref "${repo_dir}" "${repo_name}" "${ref}"
}

echo "[thestuu-native] vendor dir: ${VENDOR_DIR}"
echo "[thestuu-native] JUCE ref: ${JUCE_REF}"
echo "[thestuu-native] tracktion ref: ${TRACKTION_REF}"
mkdir -p "${VENDOR_DIR}"

if [[ -d "${JUCE_DIR}/.git" ]]; then
  checkout_repo_ref "${JUCE_DIR}" "JUCE" "${JUCE_REF}"
else
  clone_repo "JUCE" "https://github.com/juce-framework/JUCE.git" "${JUCE_DIR}" "${JUCE_REF}"
fi

if [[ -d "${TRACKTION_DIR}/.git" ]]; then
  checkout_repo_ref "${TRACKTION_DIR}" "tracktion_engine" "${TRACKTION_REF}"
else
  clone_repo "tracktion_engine" "https://github.com/Tracktion/tracktion_engine.git" "${TRACKTION_DIR}" "${TRACKTION_REF}"
fi

echo "[thestuu-native] vendor bootstrap complete"
