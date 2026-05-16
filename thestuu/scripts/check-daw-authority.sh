#!/usr/bin/env bash
# check-daw-authority.sh — CI guard for DAW state authority (Phase 0).
#
# Fails when NEW usages appear outside the legacy allowlist:
#   - syncNativeArrangementFromPlaylist
#   - projectHistory.undo.push / projectHistory.redo.push (JSON DAW undo stacks)
#
# Allowlist (update when migrating call sites off server.js):
#   apps/engine/src/server.js — entire file until Phase 2–6 removes last legacy paths.
#
# After removing a callsite from server.js, delete or narrow the allowlist entry here.
# Run from monorepo root: npm run check:daw-authority

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOWLIST="apps/engine/src/server.js"

if ! command -v rg >/dev/null 2>&1; then
  echo "check-daw-authority: ripgrep (rg) is required" >&2
  exit 1
fi

RG_GLOBS=(
  --glob '*.js'
  --glob '*.mjs'
  --glob '*.cjs'
  --glob '*.ts'
  --glob '*.tsx'
  --glob '*.jsx'
  --glob '!**/node_modules/**'
)

fail_with_hits() {
  local label="$1"
  shift
  if [[ $# -gt 0 ]]; then
    echo "check-daw-authority: disallowed ${label} outside allowlist (${ALLOWLIST}):" >&2
    printf '  %s\n' "$@" >&2
    exit 1
  fi
}

normalize_path() {
  local p="$1"
  p="${p#./}"
  p="${p#/}"
  printf '%s' "$p"
}

is_allowlisted() {
  local file
  file="$(normalize_path "$1")"
  [[ "$file" == "$ALLOWLIST" ]]
}

collect_violations() {
  local pattern="$1"
  local -a out=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local file="${line%%:*}"
    if ! is_allowlisted "$file"; then
      out+=("$line")
    fi
  done < <(rg -n "$pattern" "${RG_GLOBS[@]}" . 2>/dev/null || true)
  if [[ ${#out[@]} -gt 0 ]]; then
    fail_with_hits "$2" "${out[@]}"
  fi
}

collect_violations 'syncNativeArrangementFromPlaylist' 'syncNativeArrangementFromPlaylist'
collect_violations 'projectHistory\.(undo|redo)\.push' 'projectHistory.undo.push / projectHistory.redo.push'

echo "check-daw-authority: OK (allowlist: ${ALLOWLIST})"
