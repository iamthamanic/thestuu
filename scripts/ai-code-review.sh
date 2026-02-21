#!/usr/bin/env bash
# AI code review: Codex only (Cursor disabled). Called from run-checks.sh.
# Prompt: Senior-Software-Architekt, 100 Punkte, Checkliste (SOLID, DRY, Performance, Sicherheit, Robustheit, Wartbarkeit), JSON score/deductions/verdict.
# When verdict is REJECT: address all checklist points per affected file in one pass - see AGENTS.md and docs/AI_REVIEW_WHY_NEW_ERRORS_AFTER_FIXES.md.
# Codex: codex in PATH; use session after codex login (ChatGPT account, no API key in terminal).
# CHECK_MODE controls which diff the AI gets:
#   CHECK_MODE=snippet (default): Changed code snippets only.
#   CHECK_MODE=full: chunked review per directory (src, supabase, scripts, dashboard).
# Extra controls:
#   AI_REVIEW_DIFF_RANGE: force snippet diff range (e.g. @{u}...HEAD).
#   AI_REVIEW_DIFF_FILE: force snippet diff input from file.
#   AI_REVIEW_CHUNK: force full-mode chunk path(s), comma-separated.
# Optional machine-readable report:
#   SHIM_REPORT_FILE or REFACTOR_REPORT_FILE -> writes a JSON summary.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CHECK_MODE="${CHECK_MODE:-snippet}"
[[ "$CHECK_MODE" == "diff" ]] && CHECK_MODE=snippet

AI_REVIEW_DIFF_RANGE="${AI_REVIEW_DIFF_RANGE:-}"
AI_REVIEW_DIFF_FILE="${AI_REVIEW_DIFF_FILE:-}"
AI_REVIEW_CHUNK="${AI_REVIEW_CHUNK:-}"

TIMEOUT_SEC="${SHIM_AI_TIMEOUT_SEC:-180}"
CHUNK_TIMEOUT="${SHIM_AI_CHUNK_TIMEOUT:-600}"
LIMIT_BYTES="${SHIM_AI_DIFF_LIMIT_BYTES:-51200}"
MIN_RATING="${SHIM_AI_MIN_RATING:-95}"
CHUNK_LIMIT_BYTES="${SHIM_AI_CHUNK_LIMIT_BYTES:-153600}"

REVIEWS_DIR_SETTING="${SHIM_AI_REVIEW_DIR:-.shimwrapper/reviews}"
if [[ "$REVIEWS_DIR_SETTING" = /* ]]; then
  REVIEWS_DIR="$REVIEWS_DIR_SETTING"
else
  REVIEWS_DIR="$ROOT_DIR/$REVIEWS_DIR_SETTING"
fi

REPORT_FILE="${SHIM_REPORT_FILE:-${REFACTOR_REPORT_FILE:-}}"
if [[ -n "$REPORT_FILE" ]] && [[ "$REPORT_FILE" != /* ]]; then
  REPORT_FILE="$ROOT_DIR/$REPORT_FILE"
fi

to_int_or_default() {
  local value="$1"
  local fallback="$2"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "$value"
  else
    echo "$fallback"
  fi
}

trim() {
  local s="$1"
  # shellcheck disable=SC2001
  s="$(echo "$s" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  echo "$s"
}

resolve_path() {
  local p="$1"
  if [[ "$p" = /* ]]; then
    echo "$p"
  else
    echo "$ROOT_DIR/$p"
  fi
}

json_escape() {
  if command -v perl >/dev/null 2>&1; then
    printf '%s' "$1" | perl -0777 -pe 's/\\/\\\\/g; s/"/\\"/g; s/\r?\n/\\n/g'
  else
    # Portable fallback: flatten newlines if perl is unavailable.
    printf '%s' "$1" | tr '\n' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
  fi
}

write_machine_report() {
  local payload="$1"
  [[ -z "$REPORT_FILE" ]] && return 0
  mkdir -p "$(dirname "$REPORT_FILE")"
  printf '%s\n' "$payload" > "$REPORT_FILE"
}

write_skipped_report() {
  local reason="$1"
  write_machine_report "{\"kind\":\"ai-review\",\"mode\":\"$(json_escape "$CHECK_MODE")\",\"status\":\"skipped\",\"reason\":\"$(json_escape "$reason")\"}"
}

write_failed_report() {
  local reason="$1"
  write_machine_report "{\"kind\":\"ai-review\",\"mode\":\"$(json_escape "$CHECK_MODE")\",\"status\":\"fail\",\"reason\":\"$(json_escape "$reason")\"}"
}

TIMEOUT_SEC="$(to_int_or_default "$TIMEOUT_SEC" 180)"
CHUNK_TIMEOUT="$(to_int_or_default "$CHUNK_TIMEOUT" 600)"
LIMIT_BYTES="$(to_int_or_default "$LIMIT_BYTES" 51200)"
MIN_RATING="$(to_int_or_default "$MIN_RATING" 95)"
CHUNK_LIMIT_BYTES="$(to_int_or_default "$CHUNK_LIMIT_BYTES" 153600)"

# Use real git for diffs (PATH may point to a shim). Only allow trusted binaries.
if [[ "${GIT_CMD:-}" = "/usr/bin/git" ]] && [[ -x /usr/bin/git ]]; then
  GIT_CMD="/usr/bin/git"
elif [[ "${GIT_CMD:-}" = "git" ]] && command -v git >/dev/null 2>&1; then
  GIT_CMD="git"
elif [[ -x /usr/bin/git ]]; then
  GIT_CMD="/usr/bin/git"
elif command -v git >/dev/null 2>&1; then
  GIT_CMD="git"
else
  echo "Skipping AI review: no git found (need /usr/bin/git or git in PATH)." >&2
  write_failed_report "git not available"
  exit 1
fi

TEMP_FILES=()
register_tmp() {
  TEMP_FILES+=("$1")
}
cleanup() {
  local f=""
  for f in "${TEMP_FILES[@]}"; do
    [[ -n "$f" ]] && [[ -f "$f" ]] && rm -f "$f"
  done
}
trap cleanup EXIT

mkdir -p "$REVIEWS_DIR"
REVIEW_DATE="$(date +%d.%m.%Y)"
REVIEW_TIME="$(date +%H:%M:%S)"

build_prompt_head() {
  cat <<PROMPT_HEAD_END
Du bist ein extrem strenger Senior-Software-Architekt. Deine Aufgabe ist es, einen Code-Diff zu bewerten.

Regeln:
Starte mit 100 Punkten. Gehe die folgende Checkliste durch und ziehe fuer jeden Verstoss die angegebenen Punkte ab. Sei gnadenlos. Ein "okay" reicht nicht fuer ${MIN_RATING}%. ${MIN_RATING}% bedeutet Weltklasse-Niveau.

1. Architektur & SOLID
- Single Responsibility (SRP): Hat die Klasse/Funktion mehr als einen Grund, sich zu aendern? (Abzug: -15)
- Dependency Inversion: Werden Abhaengigkeiten (z.B. DB, APIs) hart instanziiert oder injiziert? (Abzug: -10)
- Kopplung: Zirkulaere Abhaengigkeiten oder zu tief verschachtelte Importe? (Abzug: -10)
- YAGNI: Code fuer "zukuenftige Faelle", der jetzt nicht gebraucht wird? (Abzug: -5)

2. Performance & Ressourcen
- Zeitkomplexitaet: Verschachtelte Schleifen O(n^2), die bei grossen Datenmengen explodieren? (Abzug: -20)
- N+1: Werden in einer Schleife Datenbankabfragen gemacht? (Abzug: -20)
- Memory Leaks: Event-Listener oder Streams geoeffnet, aber nicht geschlossen? (Abzug: -15)
- Bundle-Size: Riesige Bibliotheken importiert fuer eine kleine Funktion? (Abzug: -5)

3. Sicherheit
- IDOR: API akzeptiert ID (z.B. user_id) ohne Pruefung, ob der User diese Ressource sehen darf? (Abzug: -25)
- Data Leakage: Sensible Daten in Logs oder Frontend? (Abzug: -20)
- Rate Limiting: Funktion durch massenhafte Aufrufe lahmlegbar? (Abzug: -10)
- Path Traversal / File-IO: Nutzer-Input landet ungeprueft in Dateipfaden (path.join/readFile/writeFile/copy/symlink)? (Abzug: -25)
- Command Injection: Nutzer-Input in Shell/Exec/Spawn ohne sichere Trennung/Allowlist? (Abzug: -25)

4. Robustheit & Error Handling
- Silent Fails: Leere catch-Bloecke, die Fehler verschlucken? (Abzug: -15)
- Input Validation: Externe Daten validiert vor Verarbeitung? (Abzug: -15)
- Edge Cases: null, undefined, [], extrem lange Strings? (Abzug: -10)

5. Wartbarkeit & Lesbarkeit
- DRY (Don't Repeat Yourself): Deutlich duplizierte Logik/Bloecke ohne gemeinsame Funktion/Helfer? (Abzug: -5)
- Naming: Variablennamen beschreibend oder data, info, item? (Abzug: -5)
- Side Effects: Funktion veraendert unvorhersehbar globale Zustaende? (Abzug: -10)
- Kommentar-Qualitaet: Erklaert der Kommentar das "Warum" oder nur das "Was"? (Abzug: -2)

Gib das Ergebnis NUR als ein einziges gueltiges JSON-Objekt aus, kein anderer Text. Format:
{"score": number, "deductions": [{"point": "Kurzname", "minus": number, "reason": "Begruendung"}], "verdict": "ACCEPT" oder "REJECT"}
verdict: "ACCEPT" nur wenn score >= ${MIN_RATING}; sonst "REJECT".

--- DIFF ---
PROMPT_HEAD_END
}

PROMPT_HEAD="$(build_prompt_head)"

if [[ "$CHECK_MODE" == "full" ]]; then
  if ! command -v codex >/dev/null 2>&1; then
    echo "Skipping AI review: Codex CLI not available (run codex login or install codex in PATH)." >&2
    write_skipped_report "codex cli not available"
    exit 0
  fi

  EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  HAS_HEAD=0
  if "$GIT_CMD" rev-parse --verify HEAD >/dev/null 2>&1; then
    HAS_HEAD=1
  fi
  CHUNK_DIRS=()

  if [[ -n "$AI_REVIEW_CHUNK" ]]; then
    IFS=',' read -r -a raw_chunks <<< "$AI_REVIEW_CHUNK"
    for raw in "${raw_chunks[@]}"; do
      chunk="$(trim "$raw")"
      [[ -n "$chunk" ]] && CHUNK_DIRS+=("$chunk")
    done
  else
    for d in src supabase scripts dashboard; do
      [[ -d "$ROOT_DIR/$d" ]] && CHUNK_DIRS+=("$d")
    done
  fi

  if [[ "${#CHUNK_DIRS[@]}" -eq 0 ]]; then
    echo "Skipping AI review (CHECK_MODE=full): no chunk directories available." >&2
    write_skipped_report "no chunk directories available"
    exit 0
  fi

  echo "AI review: CHECK_MODE=full (chunked per directory: ${CHUNK_DIRS[*]})." >&2
  REVIEW_FILE="$REVIEWS_DIR/review-${CHECK_MODE}-${REVIEW_DATE}-$(date +%H-%M-%S).md"

  BRANCH=""
  [[ -n "${GIT_BRANCH:-}" ]] && BRANCH="$GIT_BRANCH" || BRANCH="$($GIT_CMD rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
  OVERALL_PASS=1
  CHUNK_REPORT_ITEMS=""

  for chunk_dir in "${CHUNK_DIRS[@]}"; do
    CHUNK_DIFF="$(mktemp)"
    register_tmp "$CHUNK_DIFF"
    if [[ "$HAS_HEAD" -eq 1 ]]; then
      "$GIT_CMD" diff --no-color "$EMPTY_TREE"..HEAD -- "$chunk_dir" > "$CHUNK_DIFF" 2>/dev/null || true
    else
      # Initial repository state: compare working tree chunk against empty tree.
      diff -ruN --exclude='.git' --exclude='node_modules' /dev/null "$ROOT_DIR/$chunk_dir" > "$CHUNK_DIFF" 2>/dev/null || true
    fi

    CHUNK_PASS=1
    CHUNK_VERDICT="ACCEPT"
    CHUNK_RATING=100
    CHUNK_DEDUCTIONS="[]"
    CHUNK_RAW="(no diff)"
    CHUNK_NOTE=""

    if [[ ! -s "$CHUNK_DIFF" ]]; then
      CHUNK_NOTE="(skip: no changes in $chunk_dir)"
    else
      CHUNK_SIZE=$(wc -c < "$CHUNK_DIFF")
      CHUNK_CONTENT=""
      if [[ "$CHUNK_SIZE" -le "$CHUNK_LIMIT_BYTES" ]]; then
        CHUNK_CONTENT="$(cat "$CHUNK_DIFF")"
      else
        HALF=$((CHUNK_LIMIT_BYTES / 2))
        CHUNK_CONTENT="$(head -c "$HALF" "$CHUNK_DIFF")
... (chunk truncated, was ${CHUNK_SIZE} bytes) ...
$(tail -c "$HALF" "$CHUNK_DIFF")"
        CHUNK_NOTE="(chunk truncated from ${CHUNK_SIZE} bytes to ${CHUNK_LIMIT_BYTES})"
      fi

      CODEX_JSON_C="$(mktemp)"
      CODEX_MSG_C="$(mktemp)"
      register_tmp "$CODEX_JSON_C"
      register_tmp "$CODEX_MSG_C"

      CHUNK_PROMPT="${PROMPT_HEAD}
${CHUNK_CONTENT}"
      CODEX_RC=0
      if command -v timeout >/dev/null 2>&1; then
        timeout "$CHUNK_TIMEOUT" codex exec --json -o "$CODEX_MSG_C" "$CHUNK_PROMPT" 2>/dev/null > "$CODEX_JSON_C" || CODEX_RC=$?
      else
        codex exec --json -o "$CODEX_MSG_C" "$CHUNK_PROMPT" 2>/dev/null > "$CODEX_JSON_C" || CODEX_RC=$?
      fi

      if [[ "$CODEX_RC" -eq 124 ]] || [[ "$CODEX_RC" -eq 142 ]]; then
        CHUNK_PASS=0
        CHUNK_VERDICT="REJECT"
        CHUNK_RATING=0
        CHUNK_RAW="(timeout after ${CHUNK_TIMEOUT}s)"
        CHUNK_NOTE="(timeout)"
      elif [[ "$CODEX_RC" -ne 0 ]]; then
        CHUNK_PASS=0
        CHUNK_VERDICT="REJECT"
        CHUNK_RAW="(codex exit $CODEX_RC)"
      else
        RESULT_TEXT_C=""
        if command -v jq >/dev/null 2>&1; then
          while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            type="$(echo "$line" | jq -r '.type // empty')"
            if [[ "$type" == "item.completed" ]]; then
              item_type="$(echo "$line" | jq -r '.item.item_type // empty')"
              if [[ "$item_type" == "assistant_message" ]]; then
                RESULT_TEXT_C="$(echo "$line" | jq -r '.item.text // empty')"
              fi
            fi
          done < "$CODEX_JSON_C"
        fi

        [[ -z "$RESULT_TEXT_C" ]] && [[ -s "$CODEX_MSG_C" ]] && RESULT_TEXT_C="$(cat "$CODEX_MSG_C")"
        CHUNK_RAW="${RESULT_TEXT_C:- (no response)}"

        if [[ -n "$RESULT_TEXT_C" ]] && command -v node >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
          RESULT_TMP="$(mktemp)"
          register_tmp "$RESULT_TMP"
          printf '%s' "$RESULT_TEXT_C" > "$RESULT_TMP"
          RESULT_JSON_C=$(node -e "
            const fs = require('fs');
            const d = fs.readFileSync(process.argv[1], 'utf8');
            const m = d.match(/\{[\s\S]*\}/);
            if (!m) process.exit(1);
            try { console.log(JSON.stringify(JSON.parse(m[0]))); } catch (e) { process.exit(2); }
          " "$RESULT_TMP" 2>/dev/null || true)
          if [[ -n "$RESULT_JSON_C" ]]; then
            CHUNK_RATING=$(echo "$RESULT_JSON_C" | jq -r '.score // 0')
            CHUNK_VERDICT=$(echo "$RESULT_JSON_C" | jq -r '.verdict // "REJECT"')
            CHUNK_DEDUCTIONS=$(echo "$RESULT_JSON_C" | jq -r '.deductions // []')
            CHUNK_VERDICT=$(echo "$CHUNK_VERDICT" | tr '[:lower:]' '[:upper:]')
            [[ "$CHUNK_VERDICT" != "ACCEPT" ]] && CHUNK_VERDICT="REJECT"
            [[ "$CHUNK_RATING" =~ ^[0-9]+$ ]] || CHUNK_RATING=0
            [[ "$CHUNK_RATING" -lt "$MIN_RATING" ]] 2>/dev/null && CHUNK_PASS=0
            [[ "$CHUNK_VERDICT" != "ACCEPT" ]] && CHUNK_PASS=0
          fi
        fi
      fi
    fi

    [[ "$CHUNK_PASS" -ne 1 ]] && OVERALL_PASS=0

    {
      echo ""
      echo "## Chunk: $chunk_dir"
      echo ""
      echo "- **Verdict:** $([ "$CHUNK_PASS" -eq 1 ] && echo "PASS" || echo "FAIL") ($CHUNK_VERDICT)"
      echo "- **Score:** ${CHUNK_RATING}%"
      [[ -n "$CHUNK_NOTE" ]] && echo "- **Note:** $CHUNK_NOTE"
      echo ""
      CHUNK_DEDUCTIONS_COUNT=0
      if [[ -n "$CHUNK_DEDUCTIONS" ]] && [[ "$CHUNK_DEDUCTIONS" != "[]" ]] && command -v jq >/dev/null 2>&1; then
        CHUNK_DEDUCTIONS_COUNT=$(echo "$CHUNK_DEDUCTIONS" | jq -r "length // 0" 2>/dev/null || echo 0)
      fi
      if [[ "$CHUNK_DEDUCTIONS_COUNT" -gt 0 ]]; then
        echo "### Findings"
        echo ""
        echo "$CHUNK_DEDUCTIONS" | jq -r '.[] | "- [FAIL] **\(.point)**: -\(.minus) -- \(.reason)"' 2>/dev/null || echo "$CHUNK_DEDUCTIONS"
      else
        echo "### No findings"
        echo ""
        echo "- No deductions in this chunk."
      fi
      echo ""
      echo "### Raw response"
      echo ""
      echo '```'
      echo "$CHUNK_RAW"
      echo '```'
    } >> "$REVIEW_FILE"

    chunk_item_note="null"
    if [[ -n "$CHUNK_NOTE" ]]; then
      chunk_item_note="\"$(json_escape "$CHUNK_NOTE")\""
    fi
    chunk_item="{\"chunk\":\"$(json_escape "$chunk_dir")\",\"pass\":$([ "$CHUNK_PASS" -eq 1 ] && echo true || echo false),\"score\":${CHUNK_RATING},\"verdict\":\"$(json_escape "$CHUNK_VERDICT")\",\"note\":${chunk_item_note}}"
    if [[ -n "$CHUNK_REPORT_ITEMS" ]]; then
      CHUNK_REPORT_ITEMS+=" , ${chunk_item}"
    else
      CHUNK_REPORT_ITEMS="$chunk_item"
    fi
  done

  {
    echo "# AI Code Review - Date $REVIEW_DATE  Time $REVIEW_TIME"
    echo ""
    echo "- **Mode:** full (chunked)"
    echo "- **Branch:** $BRANCH"
    echo "- **Verdict:** $([ "$OVERALL_PASS" -eq 1 ] && echo "PASS" || echo "FAIL") (all chunks must be ACCEPT and score >= ${MIN_RATING})"
    echo ""
    echo "---"
  } > "$REVIEW_FILE.tmp"
  cat "$REVIEW_FILE.tmp" "$REVIEW_FILE" > "$REVIEW_FILE.new"
  mv "$REVIEW_FILE.new" "$REVIEW_FILE"
  rm -f "$REVIEW_FILE.tmp"

  echo "Review saved: $REVIEW_FILE" >&2
  if [[ "$OVERALL_PASS" -eq 1 ]]; then
    echo "Codex AI review: PASS (all chunks)" >&2
  else
    echo "Codex AI review: FAIL (one or more chunks failed)" >&2
  fi

  report_status="fail"
  report_pass=false
  if [[ "$OVERALL_PASS" -eq 1 ]]; then
    report_status="pass"
    report_pass=true
  fi
  write_machine_report "{\"kind\":\"ai-review\",\"mode\":\"full\",\"status\":\"${report_status}\",\"pass\":${report_pass},\"minRating\":${MIN_RATING},\"reviewFile\":\"$(json_escape "$REVIEW_FILE")\",\"chunks\":[${CHUNK_REPORT_ITEMS}]}"

  [[ "$OVERALL_PASS" -eq 1 ]] && exit 0 || exit 1
fi

# Snippet path (CHECK_MODE=snippet).
DIFF_FILE="$(mktemp)"
register_tmp "$DIFF_FILE"
DIFF_SOURCE="auto"

if [[ -n "$AI_REVIEW_DIFF_FILE" ]]; then
  diff_source_file="$(resolve_path "$AI_REVIEW_DIFF_FILE")"
  if [[ ! -f "$diff_source_file" ]]; then
    echo "AI review: AI_REVIEW_DIFF_FILE not found: $diff_source_file" >&2
    write_failed_report "AI_REVIEW_DIFF_FILE not found: $diff_source_file"
    exit 1
  fi
  cat "$diff_source_file" > "$DIFF_FILE"
  DIFF_SOURCE="diff_file"
  echo "AI review: CHECK_MODE=snippet (AI_REVIEW_DIFF_FILE)." >&2
elif [[ -n "$AI_REVIEW_DIFF_RANGE" ]]; then
  "$GIT_CMD" diff --no-color "$AI_REVIEW_DIFF_RANGE" > "$DIFF_FILE" 2>/dev/null
  r=$?
  if [[ "$r" -ne 0 && "$r" -ne 1 ]]; then
    echo "AI review: git diff (AI_REVIEW_DIFF_RANGE=$AI_REVIEW_DIFF_RANGE) failed (exit $r)." >&2
    write_failed_report "git diff failed for AI_REVIEW_DIFF_RANGE=$AI_REVIEW_DIFF_RANGE"
    exit 1
  fi
  DIFF_SOURCE="diff_range"
  echo "AI review: CHECK_MODE=snippet (AI_REVIEW_DIFF_RANGE)." >&2
else
  "$GIT_CMD" diff --no-color > "$DIFF_FILE" 2>/dev/null
  r=$?
  [[ "$r" -ne 0 && "$r" -ne 1 ]] && {
    echo "AI review: git diff (unstaged) failed (exit $r)." >&2
    write_failed_report "git diff unstaged failed (exit $r)"
    exit 1
  }

  "$GIT_CMD" diff --cached --no-color >> "$DIFF_FILE" 2>/dev/null
  r=$?
  [[ "$r" -ne 0 && "$r" -ne 1 ]] && {
    echo "AI review: git diff (cached) failed (exit $r)." >&2
    write_failed_report "git diff cached failed (exit $r)"
    exit 1
  }

  if [[ ! -s "$DIFF_FILE" ]]; then
    RANGE=""
    if "$GIT_CMD" rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
      RANGE="@{u}...HEAD"
    elif "$GIT_CMD" rev-parse --verify HEAD~1 >/dev/null 2>&1; then
      RANGE="HEAD~1...HEAD"
    fi
    if [[ -n "$RANGE" ]]; then
      "$GIT_CMD" diff --no-color "$RANGE" >> "$DIFF_FILE" 2>/dev/null
      r=$?
      [[ "$r" -ne 0 && "$r" -ne 1 ]] && {
        echo "AI review: git diff (range) failed (exit $r)." >&2
        write_failed_report "git diff range failed (exit $r)"
        exit 1
      }
    fi
  fi
  echo "AI review: CHECK_MODE=snippet (changes only)." >&2
fi

if [[ ! -s "$DIFF_FILE" ]]; then
  echo "Skipping AI review: no staged, unstaged, or pushed changes (CHECK_MODE=snippet)." >&2
  write_skipped_report "no snippet diff available"
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Skipping AI review: Codex CLI not available (run codex login or install codex in PATH)." >&2
  write_skipped_report "codex cli not available"
  exit 0
fi

# Limit diff to first and last chunk to avoid token limits and timeouts.
DIFF_LIMITED=""
if [[ $(wc -c < "$DIFF_FILE") -le $((LIMIT_BYTES * 2)) ]]; then
  DIFF_LIMITED="$(cat "$DIFF_FILE")"
else
  DIFF_LIMITED="$(head -c "$LIMIT_BYTES" "$DIFF_FILE")
...[truncated]...
$(tail -c "$LIMIT_BYTES" "$DIFF_FILE")"
fi

PROMPT="${PROMPT_HEAD}
${DIFF_LIMITED}"

CODEX_JSON_FILE="$(mktemp)"
CODEX_LAST_MSG_FILE="$(mktemp)"
register_tmp "$CODEX_JSON_FILE"
register_tmp "$CODEX_LAST_MSG_FILE"

echo "Running Codex AI review..." >&2
CODEX_RC=0
if command -v timeout >/dev/null 2>&1; then
  timeout "$TIMEOUT_SEC" codex exec --json -o "$CODEX_LAST_MSG_FILE" "$PROMPT" 2>/dev/null > "$CODEX_JSON_FILE" || CODEX_RC=$?
else
  codex exec --json -o "$CODEX_LAST_MSG_FILE" "$PROMPT" 2>/dev/null > "$CODEX_JSON_FILE" || CODEX_RC=$?
fi

if [[ "$CODEX_RC" -eq 124 ]] || [[ "$CODEX_RC" -eq 142 ]]; then
  echo "Codex AI review timed out after ${TIMEOUT_SEC}s." >&2
  write_failed_report "codex timeout after ${TIMEOUT_SEC}s"
  exit 1
fi

if [[ "$CODEX_RC" -ne 0 ]]; then
  echo "Codex AI review command failed (exit $CODEX_RC)." >&2
  cat "$CODEX_JSON_FILE" 2>/dev/null | head -50 >&2
  write_failed_report "codex command failed (exit $CODEX_RC)"
  exit 1
fi

# Parse JSONL: turn.completed has usage; last assistant_message is in item.completed.
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

# Fallback: use --output-last-message file.
if [[ -z "$RESULT_TEXT" ]] && [[ -s "$CODEX_LAST_MSG_FILE" ]]; then
  RESULT_TEXT="$(cat "$CODEX_LAST_MSG_FILE")"
fi

# Parse JSON review: score, deductions, verdict.
REVIEW_RATING=0
REVIEW_VERDICT="REJECT"
REVIEW_DEDUCTIONS="[]"

if [[ -n "$RESULT_TEXT" ]]; then
  RESULT_JSON=""
  if command -v node >/dev/null 2>&1; then
    RESULT_TMP="$(mktemp)"
    register_tmp "$RESULT_TMP"
    printf '%s' "$RESULT_TEXT" > "$RESULT_TMP"
    RESULT_JSON=$(node -e "
      const fs = require('fs');
      const d = fs.readFileSync(process.argv[1], 'utf8');
      const m = d.match(/\{[\s\S]*\}/);
      if (!m) process.exit(1);
      try { console.log(JSON.stringify(JSON.parse(m[0]))); } catch (e) { process.exit(2); }
    " "$RESULT_TMP" 2>/dev/null || true)
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
if [[ "$REVIEW_VERDICT" == "ACCEPT" ]] && [[ "$REVIEW_RATING" -ge "$MIN_RATING" ]]; then
  PASS=1
fi

REVIEW_DEDUCTIONS_COUNT=0
if [[ -n "$REVIEW_DEDUCTIONS" ]] && [[ "$REVIEW_DEDUCTIONS" != "[]" ]] && command -v jq >/dev/null 2>&1; then
  REVIEW_DEDUCTIONS_COUNT=$(echo "$REVIEW_DEDUCTIONS" | jq -r "length // 0" 2>/dev/null || echo 0)
fi

if [[ -n "$INPUT_T" && -n "$OUTPUT_T" ]]; then
  TOTAL=$((INPUT_T + OUTPUT_T))
  echo "Token usage: ${INPUT_T} input, ${OUTPUT_T} output (total ${TOTAL})" >&2
else
  echo "Token usage: not reported by Codex CLI" >&2
fi

REVIEW_FILE="$REVIEWS_DIR/review-${CHECK_MODE}-${REVIEW_DATE}-$(date +%H-%M-%S).md"
BRANCH=""
[[ -n "${GIT_BRANCH:-}" ]] && BRANCH="$GIT_BRANCH" || BRANCH="$($GIT_CMD rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"

{
  echo "# AI Code Review - Date $REVIEW_DATE  Time $REVIEW_TIME"
  echo ""
  echo "## Review Summary"
  echo "- **Mode:** $CHECK_MODE"
  echo "- **Branch:** $BRANCH"
  echo "- **Status:** $([ "$PASS" -eq 1 ] && echo "PASS" || echo "FAIL") ($REVIEW_VERDICT)"
  echo "- **Score:** ${REVIEW_RATING}%"
  echo "- **Min score for PASS:** ${MIN_RATING}%"
  echo "- **Tokens:** ${INPUT_T:-?} input, ${OUTPUT_T:-?} output"
  echo "- **Findings:** ${REVIEW_DEDUCTIONS_COUNT}"
  echo "- **Diff source:** ${DIFF_SOURCE}"
  [[ "$DIFF_SOURCE" == "diff_range" ]] && echo "- **Diff range:** ${AI_REVIEW_DIFF_RANGE}"
  [[ "$DIFF_SOURCE" == "diff_file" ]] && echo "- **Diff file:** ${AI_REVIEW_DIFF_FILE}"
  echo ""
  echo "## Checklist"
  echo "- Architektur & SOLID"
  echo "- Performance & Ressourcen"
  echo "- Sicherheit"
  echo "- Robustheit & Error Handling"
  echo "- Wartbarkeit & Lesbarkeit"
  echo ""
  if [[ "$REVIEW_DEDUCTIONS_COUNT" -gt 0 ]]; then
    echo "## Findings"
    echo ""
    echo "$REVIEW_DEDUCTIONS" | jq -r '.[] | "- [FAIL] **\(.point)**: -\(.minus) -- \(.reason)"' 2>/dev/null || echo "$REVIEW_DEDUCTIONS"
  else
    echo "## No findings from AI checklist"
    echo ""
    echo "- No deductions in this review scope."
  fi
  echo ""
  echo "## Raw response"
  echo ""
  echo '```'
  [[ -n "$RESULT_TEXT" ]] && echo "$RESULT_TEXT" || echo "(no review text)"
  echo '```'
} >> "$REVIEW_FILE"

echo "Review saved: $REVIEW_FILE" >&2
if [[ "$PASS" -eq 1 ]]; then
  echo "Codex AI review: PASS" >&2
else
  echo "Codex AI review: FAIL" >&2
fi
echo "Score: ${REVIEW_RATING}%" >&2
echo "Verdict: ${REVIEW_VERDICT}" >&2
if [[ -n "$REVIEW_DEDUCTIONS" ]] && [[ "$REVIEW_DEDUCTIONS" != "[]" ]]; then
  echo "Deductions:" >&2
  echo "$REVIEW_DEDUCTIONS" | jq -r '.[] | "  - \(.point): -\(.minus) -- \(.reason)"' 2>/dev/null || echo "$REVIEW_DEDUCTIONS" >&2
fi
if [[ "$PASS" -ne 1 ]]; then
  echo "Address deductions above (or in $REVIEW_FILE). Do a broad pass per affected file (IDOR, rate limiting, input validation, error handling, edge cases) before re-running - see AGENTS.md and docs/AI_REVIEW_WHY_NEW_ERRORS_AFTER_FIXES.md." >&2
fi

report_status="fail"
report_pass=false
if [[ "$PASS" -eq 1 ]]; then
  report_status="pass"
  report_pass=true
fi
write_machine_report "{\"kind\":\"ai-review\",\"mode\":\"snippet\",\"status\":\"${report_status}\",\"pass\":${report_pass},\"score\":${REVIEW_RATING},\"minRating\":${MIN_RATING},\"verdict\":\"${REVIEW_VERDICT}\",\"findings\":${REVIEW_DEDUCTIONS_COUNT},\"diffSource\":\"${DIFF_SOURCE}\",\"reviewFile\":\"$(json_escape "$REVIEW_FILE")\"}"

[[ "$PASS" -eq 1 ]] && exit 0 || exit 1
