#!/usr/bin/env bash
# shimwrappercheck-project-rules v1
# RULES_JSON [{"type":"max_lines","maxLines":300}]
# Edit via dashboard (Projektregeln → Einstellungen → Formular) or here.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# rule 1: max_lines 300
violations=0
while IFS= read -r -d '' f; do
  n=$(wc -l < "$f" 2>/dev/null || echo 0)
  if [ "$n" -gt 300 ]; then
    echo "Projektregel verletzt: $f hat $n Zeilen (max 300)"
    violations=1
  fi
done < <(
  find . \
    -type d \( -name ".git" -o -name "node_modules" -o -name ".next" -o -name "dist" -o -name "build" -o -name ".venv-semgrep" -o -name ".codex-home" \) -prune \
    -o -type f \( -name "*.ts" -o -name "*.tsx" \) -print0 2>/dev/null
)

exit "$violations"
