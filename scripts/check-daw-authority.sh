#!/usr/bin/env bash
# check-daw-authority.sh — CI guard for DAW state authority.
#
# Fails when NEW dangerous patterns appear outside the legacy allowlist.
# Canonical rules: docs/daw-authority-guardrails.md
#
# Run from monorepo root: npm run check:daw-authority

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Files that may still contain legacy arrangement mutations during migration.
ALLOWLIST=(
  "apps/engine/src/server.js"
  "apps/engine/src/authoritative-merge.js"
  "apps/engine/src/daw-authority.js"
  "apps/engine/test/daw-authority.test.js"
)

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
  --glob '!**/vendor/**'
  --glob '!**/.next/**'
  --glob '!**/build/**'
  --glob '!**/build-tracktion/**'
)

fail_with_hits() {
  local label="$1"
  shift
  if [[ $# -gt 0 ]]; then
    echo "check-daw-authority: disallowed ${label} outside allowlist:" >&2
    printf '  %s\n' "$@" >&2
    echo "  allowlist: ${ALLOWLIST[*]}" >&2
    echo "  see docs/daw-authority-guardrails.md" >&2
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
  local entry
  for entry in "${ALLOWLIST[@]}"; do
    if [[ "$file" == "$entry" ]]; then
      return 0
    fi
  done
  return 1
}

collect_violations() {
  local pattern="$1"
  local label="$2"
  local -a out=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local file="${line%%:*}"
    if ! is_allowlisted "$file"; then
      out+=("$line")
    fi
  done < <(rg -n "$pattern" "${RG_GLOBS[@]}" . 2>/dev/null || true)
  if [[ ${#out[@]} -gt 0 ]]; then
    fail_with_hits "$label" "${out[@]}"
  fi
}

# Legacy full-edit sync (do not add new call sites).
collect_violations 'syncNativeArrangementFromPlaylist' 'syncNativeArrangementFromPlaylist'

# JSON DAW undo stacks when native undo should own arrangement.
collect_violations 'projectHistory\.(undo|redo)\.push' 'projectHistory.undo.push / projectHistory.redo.push'

# Direct arrangement mutation smells (forbid outside legacy hub).
collect_violations '\bclip\.start\s*=' 'clip.start assignment'
collect_violations '\bclip\.length\s*=' 'clip.length assignment'
collect_violations 'state\.project\.tracks\b' 'state.project.tracks (use playlist)'
collect_violations 'state\.project\.playlist\s*=' 'state.project.playlist reassignment'

echo "check-daw-authority: OK (allowlist: ${ALLOWLIST[*]})"
