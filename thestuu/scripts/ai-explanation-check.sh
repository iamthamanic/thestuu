#!/usr/bin/env bash
# Full Explanation check: Codex only. Enforces "Mandatory Full Explanation Comments" (docstrings + inline comments).
# Called from run-checks.sh. Diff: staged + unstaged; if clean, uses diff of commits being pushed.
# Output: JSON score/deductions/verdict. PASS only when compliant (score >= 95 and verdict ACCEPT).
# Diff limited to ~50KB. Timeout 180s when timeout(1) available.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DIFF_FILE=""
cleanup() {
  [[ -n "$DIFF_FILE" ]] && [[ -f "$DIFF_FILE" ]] && rm -f "$DIFF_FILE"
}
trap cleanup EXIT

DIFF_FILE="$(mktemp)"
git diff --no-color >> "$DIFF_FILE" 2>/dev/null || true
git diff --cached --no-color >> "$DIFF_FILE" 2>/dev/null || true

if [[ ! -s "$DIFF_FILE" ]] && command -v git >/dev/null 2>&1; then
  RANGE=""
  if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
    RANGE="@{u}...HEAD"
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    RANGE="HEAD~1...HEAD"
  fi
  if [[ -n "$RANGE" ]]; then
    git diff --no-color "$RANGE" >> "$DIFF_FILE" 2>/dev/null || true
  fi
fi

if [[ ! -s "$DIFF_FILE" ]]; then
  echo "Skipping Full Explanation check: no staged, unstaged, or pushed changes." >&2
  exit 0
fi

LIMIT_BYTES="${SHIM_AI_DIFF_LIMIT_BYTES:-51200}"
DIFF_LIMITED=""
if [[ $(wc -c < "$DIFF_FILE") -le $((LIMIT_BYTES * 2)) ]]; then
  DIFF_LIMITED="$(cat "$DIFF_FILE")"
else
  DIFF_LIMITED="$(head -c "$LIMIT_BYTES" "$DIFF_FILE")
... (diff truncated) ...
$(tail -c "$LIMIT_BYTES" "$DIFF_FILE")"
fi

PROMPT=$(cat << 'PROMPT_END'
Du prüfst ausschließlich die Einhaltung des Standards "Mandatory Full Explanation Comments". Keine Architektur-, Performance- oder Sicherheitsbewertung.

Regeln (alle müssen erfüllt sein):
1. Jede Funktion hat eine Docstring: warum sie existiert, welches Problem sie löst, was Ein-/Ausgaben bedeuten.
2. Jede nicht-triviale Zeile hat einen Inline-Kommentar: was passiert, warum nötig, was kaputtgeht wenn entfernt.
3. Kein "nur sauberer Code" ohne Erklärung; Erklärung ist Pflicht.
4. Ausgabe sind immer vollständige Dateien, nie Teil-Snippets.

Zusatzregel: Ist der Code nicht vollständig kommentiert, gilt die Ausgabe als ungültig.

Starte mit 100 Punkten. Für jeden Verstoß: Abzug (z. B. -10 für fehlende Docstrings, -5 pro fehlender/trivialer Kommentar bei nicht-trivialen Zeilen). verdict: "ACCEPT" nur wenn score >= 95 und alle vier Regeln erfüllt; sonst "REJECT".

Bei REJECT: In der "reason" der deductions kann kurz stehen, dass der Code nachgebessert (Docstrings/Inline-Kommentare ergänzt) und der Check erneut ausgeführt werden muss, bis er besteht.

Gib das Ergebnis NUR als ein einziges gültiges JSON-Objekt aus, kein anderer Text. Format:
{"score": number, "deductions": [{"point": "Kurzname", "minus": number, "reason": "Begründung"}], "verdict": "ACCEPT" oder "REJECT"}

--- DIFF ---
PROMPT_END
)
PROMPT="${PROMPT}
${DIFF_LIMITED}"

CODEX_JSON_FILE="$(mktemp)"
CODEX_LAST_MSG_FILE="$(mktemp)"
cleanup() {
  [[ -n "$DIFF_FILE" ]] && [[ -f "$DIFF_FILE" ]] && rm -f "$DIFF_FILE"
  [[ -n "$CODEX_JSON_FILE" ]] && [[ -f "$CODEX_JSON_FILE" ]] && rm -f "$CODEX_JSON_FILE"
  [[ -n "$CODEX_LAST_MSG_FILE" ]] && [[ -f "$CODEX_LAST_MSG_FILE" ]] && rm -f "$CODEX_LAST_MSG_FILE"
}
trap cleanup EXIT

if ! command -v codex >/dev/null 2>&1; then
  echo "Skipping Full Explanation check: Codex CLI not available (run codex login or install codex in PATH)." >&2
  exit 0
fi

TIMEOUT_SEC="${SHIM_AI_TIMEOUT_SEC:-180}"
echo "Running Full Explanation check (Codex)..." >&2

CODEX_RC=0
if command -v timeout >/dev/null 2>&1; then
  timeout "$TIMEOUT_SEC" codex exec --json -o "$CODEX_LAST_MSG_FILE" "$PROMPT" 2>/dev/null > "$CODEX_JSON_FILE" || CODEX_RC=$?
else
  codex exec --json -o "$CODEX_LAST_MSG_FILE" "$PROMPT" 2>/dev/null > "$CODEX_JSON_FILE" || CODEX_RC=$?
fi

if [[ $CODEX_RC -eq 124 ]] || [[ $CODEX_RC -eq 142 ]]; then
  echo "Full Explanation check timed out after ${TIMEOUT_SEC}s." >&2
  exit 1
fi

if [[ $CODEX_RC -ne 0 ]]; then
  echo "Full Explanation check command failed (exit $CODEX_RC)." >&2
  cat "$CODEX_JSON_FILE" 2>/dev/null | head -50 >&2
  exit 1
fi

INPUT_T=""
OUTPUT_T=""
RESULT_TEXT=""
if command -v jq >/dev/null 2>&1; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    type="$(echo "$line" | jq -r '.type // empty')"
    if [[ "$type" == "turn.completed" ]]; then
      INPUT_T="$(echo "$line" | jq -r '.usage.input_tokens // empty')"
      OUTPUT_T="$(echo "$line" | jq -r '.usage.output_tokens // empty')"
    fi
    if [[ "$type" == "item.completed" ]]; then
      item_type="$(echo "$line" | jq -r '.item.item_type // empty')"
      if [[ "$item_type" == "assistant_message" ]]; then
        RESULT_TEXT="$(echo "$line" | jq -r '.item.text // empty')"
      fi
    fi
  done < "$CODEX_JSON_FILE"
fi

if [[ -z "$RESULT_TEXT" ]] && [[ -s "$CODEX_LAST_MSG_FILE" ]]; then
  RESULT_TEXT="$(cat "$CODEX_LAST_MSG_FILE")"
fi

REVIEW_RATING=0
REVIEW_VERDICT="REJECT"
REVIEW_DEDUCTIONS=""

if [[ -n "$RESULT_TEXT" ]]; then
  RESULT_JSON=""
  if command -v node >/dev/null 2>&1; then
    RESULT_TMP=$(mktemp)
    printf '%s' "$RESULT_TEXT" > "$RESULT_TMP"
    RESULT_JSON=$(node -e "
      const fs = require('fs');
      const d = fs.readFileSync(process.argv[1], 'utf8');
      const m = d.match(/\{[\s\S]*\}/);
      if (!m) process.exit(1);
      try { console.log(JSON.stringify(JSON.parse(m[0]))); } catch (e) { process.exit(2); }
    " "$RESULT_TMP" 2>/dev/null)
    rm -f "$RESULT_TMP"
  fi
  if [[ -n "$RESULT_JSON" ]] && command -v jq >/dev/null 2>&1; then
    REVIEW_RATING=$(echo "$RESULT_JSON" | jq -r '.score // 0')
    REVIEW_VERDICT=$(echo "$RESULT_JSON" | jq -r '.verdict // "REJECT"')
    REVIEW_DEDUCTIONS=$(echo "$RESULT_JSON" | jq -r '.deductions // []')
  fi
  [[ -z "$REVIEW_RATING" ]] && REVIEW_RATING=0
  [[ "$REVIEW_RATING" =~ ^[0-9]+$ ]] || REVIEW_RATING=0
  [[ "$REVIEW_RATING" -lt 0 ]] 2>/dev/null && REVIEW_RATING=0
  [[ "$REVIEW_RATING" -gt 100 ]] 2>/dev/null && REVIEW_RATING=100
  REVIEW_VERDICT=$(echo "$REVIEW_VERDICT" | tr '[:lower:]' '[:upper:]')
  [[ "$REVIEW_VERDICT" != "ACCEPT" ]] && REVIEW_VERDICT="REJECT"
fi

PASS=0
if [[ "$REVIEW_VERDICT" == "ACCEPT" ]] && [[ "$REVIEW_RATING" -ge 95 ]]; then
  PASS=1
fi

if [[ -n "$INPUT_T" && -n "$OUTPUT_T" ]]; then
  TOTAL=$((INPUT_T + OUTPUT_T))
  echo "Token usage: ${INPUT_T} input, ${OUTPUT_T} output (total ${TOTAL})" >&2
else
  echo "Token usage: not reported by Codex CLI" >&2
fi

REVIEWS_DIR="${SHIM_AI_REVIEW_DIR:-$ROOT_DIR/.shimwrapper/reviews}"
mkdir -p "$REVIEWS_DIR"
REVIEW_FILE="$REVIEWS_DIR/explanation-check-$(date +%Y%m%d-%H%M%S).md"
BRANCH=""
[[ -n "${GIT_BRANCH:-}" ]] && BRANCH="$GIT_BRANCH" || BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
{
  echo "# Full Explanation Check — $(date -Iseconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z')"
  echo ""
  echo "- **Branch:** $BRANCH"
  echo "- **Verdict:** $([ "$PASS" -eq 1 ] && echo "PASS" || echo "FAIL") ($REVIEW_VERDICT)"
  echo "- **Score:** ${REVIEW_RATING}%"
  echo "- **Tokens:** ${INPUT_T:-?} input, ${OUTPUT_T:-?} output"
  echo ""
  echo "## Deductions"
  echo ""
  if [[ -n "$REVIEW_DEDUCTIONS" ]] && [[ "$REVIEW_DEDUCTIONS" != "[]" ]]; then
    echo "$REVIEW_DEDUCTIONS" | jq -r '.[] | "- **\(.point)**: -\(.minus) — \(.reason)"' 2>/dev/null || echo "$REVIEW_DEDUCTIONS"
  else
    echo "(none)"
  fi
  echo ""
  echo "## Raw response"
  echo ""
  echo '```'
  [[ -n "$RESULT_TEXT" ]] && echo "$RESULT_TEXT" || echo "(no response text)"
  echo '```'
} >> "$REVIEW_FILE"
echo "Report saved: $REVIEW_FILE" >&2

if [[ $PASS -eq 1 ]]; then
  echo "Full Explanation check: PASS" >&2
else
  echo "Full Explanation check: FAIL" >&2
  echo "→ Fix: add missing docstrings and inline comments, then re-run the check (e.g. npm run checks or scripts/run-checks.sh) until it passes. See AGENTS.md." >&2
fi
echo "Score: ${REVIEW_RATING}%" >&2
echo "Verdict: ${REVIEW_VERDICT}" >&2
if [[ -n "$REVIEW_DEDUCTIONS" ]] && [[ "$REVIEW_DEDUCTIONS" != "[]" ]]; then
  echo "Deductions:" >&2
  echo "$REVIEW_DEDUCTIONS" | jq -r '.[] | "  - \(.point): -\(.minus) — \(.reason)"' 2>/dev/null || echo "$REVIEW_DEDUCTIONS" >&2
fi

[[ $PASS -eq 1 ]] && exit 0 || exit 1
