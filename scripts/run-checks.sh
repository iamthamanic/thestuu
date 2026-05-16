#!/usr/bin/env bash
# Shared checks for pre-push (GitHub) and supabase-checked (Supabase deploy).
# Usage: run-checks.sh [--frontend] [--backend] [--refactor|--until-95] [--no-frontend] [--no-backend] [--no-ai-review] [--no-explanation-check] ...
#   With no args: run frontend and backend checks (same as --frontend --backend). CHECK_MODE defaults to full (whole-codebase AI review).
#   --refactor / --until-95: force CHECK_MODE=full (chunked full scan). Use for refactor loops until all chunks >=95%.
#   Pre-push should set CHECK_MODE=snippet so AI review only runs on pushed changes; run-checks.sh does not override CHECK_MODE if already set.
#   AI review runs by default; use --no-ai-review to disable (or SKIP_AI_REVIEW=1).
#   Full Explanation check runs by default after AI review; use --no-explanation-check to disable (or SKIP_EXPLANATION_CHECK=1).
# Includes security: npm audit (frontend), deno audit (backend). Optional: Snyk (frontend, skip with SKIP_SNYK=1).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load .shimwrappercheckrc so CHECK_MODE, SHIM_AI_*, SHIM_RUN_* etc. are set (e.g. when dashboard runs this script)
if [[ -f "$ROOT_DIR/.shimwrappercheckrc" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT_DIR/.shimwrappercheckrc" 2>/dev/null || true
  set +a
fi

# Alias for agent/refactor workflows: if only REFACTOR_REPORT_FILE is set, map it to SHIM_REPORT_FILE.
if [[ -z "${SHIM_REPORT_FILE:-}" ]] && [[ -n "${REFACTOR_REPORT_FILE:-}" ]]; then
  export SHIM_REPORT_FILE="$REFACTOR_REPORT_FILE"
fi

# Project root for .shimwrapper/checktools (consumer project when script runs from node_modules)
PROJECT_ROOT="${SHIM_PROJECT_ROOT:-$ROOT_DIR}"
CHECKTOOLS_BIN=""
if [[ -d "$PROJECT_ROOT/.shimwrapper/checktools/node_modules/.bin" ]]; then
  CHECKTOOLS_BIN="$PROJECT_ROOT/.shimwrapper/checktools/node_modules/.bin"
fi

BACKEND_PATH_PATTERNS="${SHIM_BACKEND_PATH_PATTERNS:-supabase/functions,src/supabase/functions}"

trim() {
  local s="$1"
  # shellcheck disable=SC2001
  s="$(echo "$s" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  echo "$s"
}

to_abs_path() {
  local p="$1"
  if [[ "$p" = /* ]]; then
    echo "$p"
  else
    echo "$ROOT_DIR/$p"
  fi
}

resolve_backend_dir() {
  local patterns="$1"
  local candidate=""
  IFS=',' read -r -a items <<< "$patterns"
  for raw in "${items[@]}"; do
    candidate="$(trim "$raw")"
    candidate="${candidate#/}"
    candidate="${candidate%/}"
    [[ -z "$candidate" ]] && continue
    if [[ -d "$ROOT_DIR/$candidate" ]]; then
      echo "$ROOT_DIR/$candidate"
      return
    fi
  done
  echo ""
}

BACKEND_DIR="$(resolve_backend_dir "$BACKEND_PATH_PATTERNS")"

refactor_mode="$(echo "${SHIM_REFACTOR_MODE:-off}" | tr '[:upper:]' '[:lower:]')"
case "$refactor_mode" in
  interactive|agent|off) ;;
  *) refactor_mode="off" ;;
esac

REFACTOR_DIR="$(to_abs_path "${SHIM_REFACTOR_DIR:-.shimwrapper/refactor}")"
REFACTOR_TODO_FILE="$(to_abs_path "${SHIM_REFACTOR_TODO_FILE:-$REFACTOR_DIR/refactor-todo.json}")"
REFACTOR_STATE_FILE="$(to_abs_path "${SHIM_REFACTOR_STATE_FILE:-$REFACTOR_DIR/refactor-state.json}")"
REFACTOR_CURRENT_ITEM_FILE="$(to_abs_path "${SHIM_REFACTOR_CURRENT_ITEM_FILE:-$REFACTOR_DIR/refactor-current-item.json}")"
REVIEWS_DIR="$(to_abs_path "${SHIM_AI_REVIEW_DIR:-.shimwrapper/reviews}")"

run_frontend=false
run_backend=false
run_ai_review=true
run_explanation_check=true
run_i18n_check=true
run_sast=true
run_gitleaks=true
run_license_checker=true
run_architecture=true
run_complexity=true
run_mutation=true
run_e2e=true
run_ruff=true
run_shellcheck=true
run_refactor=false

continue_on_error="${SHIM_CONTINUE_ON_ERROR:-0}"
if [[ "$continue_on_error" != "1" ]]; then
  continue_on_error="0"
fi
allow_environment_skips="${SHIM_ALLOW_ENVIRONMENT_SKIPS:-0}"
if [[ "$allow_environment_skips" != "1" ]]; then
  allow_environment_skips="0"
fi
audit_include_dev="${SHIM_AUDIT_INCLUDE_DEV:-0}"
if [[ "$audit_include_dev" != "1" ]]; then
  audit_include_dev="0"
fi

if [[ $# -eq 0 ]]; then
  run_frontend=true
  run_backend=true
else
  for arg in "$@"; do
    case "$arg" in
      --frontend) run_frontend=true ;;
      --backend) run_backend=true ;;
      --refactor|--until-95) run_refactor=true ;;
      --no-frontend) run_frontend=false ;;
      --no-backend) run_backend=false ;;
      --no-ai-review) run_ai_review=false ;;
      --no-explanation-check) run_explanation_check=false ;;
      --no-i18n-check) run_i18n_check=false ;;
      --no-sast) run_sast=false ;;
      --no-gitleaks) run_gitleaks=false ;;
      --no-license-checker) run_license_checker=false ;;
      --no-architecture) run_architecture=false ;;
      --no-complexity) run_complexity=false ;;
      --no-mutation) run_mutation=false ;;
      --no-e2e) run_e2e=false ;;
      --no-ruff) run_ruff=false ;;
      --no-shellcheck) run_shellcheck=false ;;
      *) echo "Unknown option: $arg. Use --frontend, --backend, --refactor, --until-95, --no-frontend, --no-backend, --no-ai-review, --no-explanation-check, --no-i18n-check, --no-sast, --no-gitleaks, --no-license-checker, --no-architecture, --no-complexity, --no-mutation, --no-e2e, --no-ruff, --no-shellcheck." >&2; exit 1 ;;
    esac
  done
fi

# CHECK_MODE: only set if not already set (e.g. pre-push sets CHECK_MODE=snippet). Default full for manual/refactor runs.
[[ "$run_refactor" = true ]] && CHECK_MODE=full
export CHECK_MODE="${CHECK_MODE:-full}"
[[ "$CHECK_MODE" == "mix" ]] && CHECK_MODE=full
[[ "$CHECK_MODE" == "diff" ]] && CHECK_MODE=snippet

# Opt-out via env: SKIP_AI_REVIEW=1 disables AI review; SKIP_EXPLANATION_CHECK=1 disables Full Explanation check
[[ -n "${SKIP_AI_REVIEW:-}" ]] && run_ai_review=false
[[ -n "${SKIP_EXPLANATION_CHECK:-}" ]] && run_explanation_check=false
[[ -n "${SKIP_I18N_CHECK:-}" ]] && run_i18n_check=false

# Granular toggles from .shimwrappercheckrc (SHIM_RUN_*=1|0). Default 1 when run_frontend/run_backend is true.
run_prettier="${SHIM_RUN_PRETTIER:-1}"
run_lint="${SHIM_RUN_LINT:-1}"
run_typecheck="${SHIM_RUN_TYPECHECK:-1}"
run_project_rules="${SHIM_RUN_PROJECT_RULES:-1}"
run_check_mock_data="${SHIM_RUN_CHECK_MOCK_DATA:-1}"
run_test_run="${SHIM_RUN_TEST_RUN:-1}"
run_vite_build="${SHIM_RUN_VITE_BUILD:-1}"
run_npm_audit="${SHIM_RUN_NPM_AUDIT:-1}"
run_snyk="${SHIM_RUN_SNYK:-1}"
run_deno_fmt="${SHIM_RUN_DENO_FMT:-1}"
run_deno_lint="${SHIM_RUN_DENO_LINT:-1}"
run_deno_audit="${SHIM_RUN_DENO_AUDIT:-1}"
run_update_readme="${SHIM_RUN_UPDATE_README:-1}"
run_explanation_check_rc="${SHIM_RUN_EXPLANATION_CHECK:-1}"
run_i18n_check_rc="${SHIM_RUN_I18N_CHECK:-1}"
run_sast_rc="${SHIM_RUN_SAST:-0}"
run_gitleaks_rc="${SHIM_RUN_GITLEAKS:-0}"
run_license_checker_rc="${SHIM_RUN_LICENSE_CHECKER:-0}"
run_architecture_rc="${SHIM_RUN_ARCHITECTURE:-0}"
run_complexity_rc="${SHIM_RUN_COMPLEXITY:-0}"
run_mutation_rc="${SHIM_RUN_MUTATION:-0}"
run_e2e_rc="${SHIM_RUN_E2E:-0}"
run_ruff_rc="${SHIM_RUN_RUFF:-0}"
run_shellcheck_rc="${SHIM_RUN_SHELLCHECK:-0}"

is_frontend_check() {
  case "$1" in
    updateReadme|prettier|lint|typecheck|projectRules|i18nCheck|checkMockData|viteBuild|testRun|npmAudit|snyk) return 0 ;;
  esac
  return 1
}

is_backend_check() {
  case "$1" in
    denoFmt|denoLint|denoAudit) return 0 ;;
  esac
  return 1
}

should_run_check() {
  local id="$1"
  if is_frontend_check "$id" && [[ "$run_frontend" != true ]]; then
    return 1
  fi
  if is_backend_check "$id" && [[ "$run_backend" != true ]]; then
    return 1
  fi
  case "$id" in
    updateReadme) [[ "$run_update_readme" = "1" ]] || return 1 ;;
    prettier) [[ "$run_prettier" = "1" ]] || return 1 ;;
    lint) [[ "$run_lint" = "1" ]] || return 1 ;;
    typecheck) [[ "$run_typecheck" = "1" ]] || return 1 ;;
    projectRules) [[ "$run_project_rules" = "1" ]] || return 1 ;;
    i18nCheck)
      [[ "$run_i18n_check_rc" = "1" ]] || return 1
      [[ "$run_i18n_check" = true ]] || return 1
      ;;
    checkMockData) [[ "$run_check_mock_data" = "1" ]] || return 1 ;;
    viteBuild) [[ "$run_vite_build" = "1" ]] || return 1 ;;
    testRun) [[ "$run_test_run" = "1" ]] || return 1 ;;
    npmAudit) [[ "$run_npm_audit" = "1" ]] || return 1 ;;
    snyk)
      [[ "$run_snyk" = "1" ]] || return 1
      [[ -z "${SKIP_SNYK:-}" ]] || return 1
      ;;
    denoFmt) [[ "$run_deno_fmt" = "1" ]] || return 1 ;;
    denoLint) [[ "$run_deno_lint" = "1" ]] || return 1 ;;
    denoAudit) [[ "$run_deno_audit" = "1" ]] || return 1 ;;
    aiReview) [[ "$run_ai_review" = true ]] || return 1 ;;
    explanationCheck)
      [[ "$run_explanation_check" = true ]] || return 1
      [[ "$run_explanation_check_rc" = "1" ]] || return 1
      ;;
    sast)
      [[ "$run_sast_rc" = "1" ]] || return 1
      [[ "$run_sast" = true ]] || return 1
      ;;
    gitleaks)
      [[ "$run_gitleaks_rc" = "1" ]] || return 1
      [[ "$run_gitleaks" = true ]] || return 1
      ;;
    licenseChecker)
      [[ "$run_license_checker_rc" = "1" ]] || return 1
      [[ "$run_license_checker" = true ]] || return 1
      ;;
    architecture)
      [[ "$run_architecture_rc" = "1" ]] || return 1
      [[ "$run_architecture" = true ]] || return 1
      ;;
    complexity)
      [[ "$run_complexity_rc" = "1" ]] || return 1
      [[ "$run_complexity" = true ]] || return 1
      ;;
    mutation)
      [[ "$run_mutation_rc" = "1" ]] || return 1
      [[ "$run_mutation" = true ]] || return 1
      ;;
    e2e)
      [[ "$run_e2e_rc" = "1" ]] || return 1
      [[ "$run_e2e" = true ]] || return 1
      ;;
    ruff)
      [[ "$run_ruff_rc" = "1" ]] || return 1
      [[ "$run_ruff" = true ]] || return 1
      ;;
    shellcheck)
      [[ "$run_shellcheck_rc" = "1" ]] || return 1
      [[ "$run_shellcheck" = true ]] || return 1
      ;;
  esac
  return 0
}

resolve_extract_refactor_script() {
  local candidates=(
    "$ROOT_DIR/scripts/extract-refactor-todo.sh"
    "$ROOT_DIR/node_modules/shimwrappercheck/scripts/extract-refactor-todo.sh"
  )
  local candidate=""
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

run_refactor_orchestration() {
  if [[ "$run_refactor" != true ]]; then
    return 0
  fi
  if [[ "$refactor_mode" == "off" ]]; then
    return 0
  fi

  local extract_script=""
  extract_script="$(resolve_extract_refactor_script)"
  if [[ -z "$extract_script" ]]; then
    echo "Refactor orchestration: extract-refactor-todo.sh not found; skipping TODO/current-item generation." >&2
    return 0
  fi

  mkdir -p "$REFACTOR_DIR"
  local latest_review=""
  latest_review="$(ls -1t "$REVIEWS_DIR"/review-full-*.md 2>/dev/null | head -1 || true)"
  if [[ -z "$latest_review" ]]; then
    latest_review="$(ls -1t "$REVIEWS_DIR"/review-*.md 2>/dev/null | head -1 || true)"
  fi
  if [[ -z "$latest_review" ]]; then
    echo "Refactor orchestration: no review file found under $REVIEWS_DIR; skipping." >&2
    return 0
  fi

  if ! bash "$extract_script" "$latest_review" "$REFACTOR_TODO_FILE"; then
    echo "Refactor orchestration: failed to extract TODO from $latest_review." >&2
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Refactor orchestration: node not available; skipping current-item handoff." >&2
    return 0
  fi

  local handoff_message=""
  handoff_message="$(
    node - "$REFACTOR_TODO_FILE" "$REFACTOR_STATE_FILE" "$REFACTOR_CURRENT_ITEM_FILE" "$latest_review" "$refactor_mode" "${SHIM_REFACTOR_ITEM_INDEX:-}" "${SHIM_REFACTOR_ADVANCE:-0}" <<'NODE'
const fs = require("fs");
const path = require("path");

const [
  todoPath,
  statePath,
  currentItemPath,
  sourceReviewPath,
  mode,
  overrideIndexRaw,
  advanceRaw,
] = process.argv.slice(2);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

const todoDoc = readJson(todoPath, { items: [] });
const allItems = Array.isArray(todoDoc.items) ? todoDoc.items : [];
const openItems = allItems.filter((item) => item && item.status !== "done" && item.status !== "resolved");
const stateDoc = readJson(statePath, {});

let currentIndex = 0;
if (/^\d+$/.test(String(overrideIndexRaw || ""))) {
  currentIndex = Number(overrideIndexRaw);
} else if (Number.isInteger(stateDoc.currentIndex)) {
  currentIndex = stateDoc.currentIndex;
}
if (String(advanceRaw) === "1") {
  currentIndex += 1;
}
if (currentIndex < 0) {
  currentIndex = 0;
}
if (openItems.length > 0 && currentIndex >= openItems.length) {
  currentIndex = openItems.length - 1;
}

const currentItem = openItems[currentIndex] ?? null;
const timestamp = new Date().toISOString();
const phase = currentItem ? "item" : "verify";

const statePayload = {
  mode,
  phase,
  workflowPhases: ["scan", "item", "verify"],
  sourceReview: sourceReviewPath,
  currentIndex: currentItem ? currentIndex : 0,
  totalItems: openItems.length,
  updatedAt: timestamp,
};

fs.mkdirSync(path.dirname(statePath), { recursive: true });
fs.writeFileSync(statePath, `${JSON.stringify(statePayload, null, 2)}\n`, "utf8");

const currentItemPayload = {
  mode,
  phase,
  workflowPhases: ["scan", "item", "verify"],
  sourceReview: sourceReviewPath,
  itemIndex: currentItem ? currentIndex : 0,
  totalItems: openItems.length,
  remainingItems: currentItem ? openItems.length - currentIndex : 0,
  generatedAt: timestamp,
  resume: {
    advanceEnv: "SHIM_REFACTOR_ADVANCE=1",
    selectIndexEnv: "SHIM_REFACTOR_ITEM_INDEX=<n>",
    rerunCommand: "./scripts/run-checks.sh --refactor",
  },
  item: currentItem,
};

fs.mkdirSync(path.dirname(currentItemPath), { recursive: true });
fs.writeFileSync(currentItemPath, `${JSON.stringify(currentItemPayload, null, 2)}\n`, "utf8");

if (!currentItem) {
  console.log("Refactor backlog clean: no open TODO items found.");
} else {
  const label = currentItem.title || currentItem.point || currentItem.id || `item-${currentIndex + 1}`;
  console.log(`Refactor current item ${currentIndex + 1}/${openItems.length}: ${label}`);
}
NODE
  )" || true

  [[ -n "$handoff_message" ]] && echo "$handoff_message"
  echo "Refactor TODO: $REFACTOR_TODO_FILE"
  echo "Refactor current item: $REFACTOR_CURRENT_ITEM_FILE"
  echo "Refactor state: $REFACTOR_STATE_FILE"
  if [[ "$refactor_mode" == "interactive" ]]; then
    echo "Interactive resume: fix the current item, then run SHIM_REFACTOR_ADVANCE=1 ./scripts/run-checks.sh --refactor"
  fi
}

# If SHIM_CHECK_ORDER is set: run checks in this exact order (like My Checks).
run_one() {
  local id="$1"
  case "$id" in
    prettier)
      [[ "$run_prettier" = "1" ]] && {
        echo "Prettier..."
        if [[ -n "$CHECKTOOLS_BIN" ]] && [[ -x "$CHECKTOOLS_BIN/prettier" ]]; then
          "$CHECKTOOLS_BIN/prettier" --check .
        else
          (npm run format:check 2>/dev/null) || npx prettier --check .
        fi
      }
      ;;
    lint)
      [[ "$run_lint" = "1" ]] && {
        echo "Lint..."
        if [[ -n "$CHECKTOOLS_BIN" ]] && [[ -x "$CHECKTOOLS_BIN/eslint" ]]; then
          "$CHECKTOOLS_BIN/eslint" .
        else
          npm run lint
        fi
      }
      ;;
    typecheck)
      [[ "$run_typecheck" = "1" ]] && {
        echo "TypeScript check..."
        if [[ -n "$CHECKTOOLS_BIN" ]] && [[ -x "$CHECKTOOLS_BIN/tsc" ]]; then
          "$CHECKTOOLS_BIN/tsc" --noEmit
        else
          (npm run typecheck 2>/dev/null) || npx tsc --noEmit
        fi
      }
      ;;
    projectRules)
      [[ "$run_project_rules" = "1" ]] && {
        echo "Projektregeln..."
        if [[ -f "$ROOT_DIR/scripts/checks/project-rules.sh" ]]; then
          bash "$ROOT_DIR/scripts/checks/project-rules.sh"
        else
          echo "Skipping Projektregeln: scripts/checks/project-rules.sh not found." >&2
        fi
      }
      ;;
    checkMockData)
      [[ "$run_check_mock_data" = "1" ]] && {
        echo "Check mock data..."
        npm run check:mock-data
      }
      ;;
    testRun)
      [[ "$run_test_run" = "1" ]] && {
        echo "Test run..."
        if [[ -n "$CHECKTOOLS_BIN" ]] && [[ -x "$CHECKTOOLS_BIN/vite" ]] && [[ -x "$CHECKTOOLS_BIN/vitest" ]]; then
          "$CHECKTOOLS_BIN/vite" build
          "$CHECKTOOLS_BIN/vitest" run
        else
          npm run build
          npm run test:run
        fi
      }
      ;;
    viteBuild)
      [[ "$run_vite_build" = "1" ]] && {
        echo "Vite build..."
        if [[ -n "$CHECKTOOLS_BIN" ]] && [[ -x "$CHECKTOOLS_BIN/vite" ]]; then
          "$CHECKTOOLS_BIN/vite" build
        else
          npm run build
        fi
      }
      ;;
    npmAudit)
      [[ "$run_npm_audit" = "1" ]] && {
        echo "npm audit..."
        audit_args=(--audit-level="${SHIM_AUDIT_LEVEL:-high}")
        if [[ "$audit_include_dev" != "1" ]]; then
          audit_args+=(--omit=dev)
        fi
        set +e
        audit_output="$(npm audit "${audit_args[@]}" 2>&1)"
        audit_rc=$?
        set -e
        [[ -n "$audit_output" ]] && echo "$audit_output"
        if [[ $audit_rc -ne 0 ]]; then
          if echo "$audit_output" | grep -Eqi 'ENOTFOUND|EAI_AGAIN|ECONNRESET|network request|audit endpoint returned an error'; then
            if [[ "$allow_environment_skips" == "1" ]]; then
              echo "Skipping npm audit: network unavailable." >&2
            else
              echo "npm audit failed: network unavailable (set SHIM_ALLOW_ENVIRONMENT_SKIPS=1 to allow skip)." >&2
              return "$audit_rc"
            fi
          else
            return "$audit_rc"
          fi
        fi
      }
      ;;
    snyk)
      if [[ "$run_snyk" = "1" ]] && [[ -z "${SKIP_SNYK:-}" ]]; then
        if command -v snyk >/dev/null 2>&1; then
          echo "Snyk..."
          snyk test
        elif npm exec --yes snyk -- --version >/dev/null 2>&1; then
          echo "Snyk..."
          npx snyk test
        else
          echo "Skipping Snyk: not installed." >&2
        fi
      fi
      ;;
    denoFmt)
      [[ "$run_deno_fmt" = "1" ]] && {
        if [[ -n "$BACKEND_DIR" ]] && [[ -d "$BACKEND_DIR" ]]; then
          echo "Deno fmt..."
          deno fmt --check "$BACKEND_DIR"
        else
          echo "Skipping Deno fmt: no backend path found in SHIM_BACKEND_PATH_PATTERNS=$BACKEND_PATH_PATTERNS" >&2
        fi
      }
      ;;
    denoLint)
      [[ "$run_deno_lint" = "1" ]] && {
        if [[ -n "$BACKEND_DIR" ]] && [[ -d "$BACKEND_DIR" ]]; then
          echo "Deno lint..."
          deno lint "$BACKEND_DIR"
        else
          echo "Skipping Deno lint: no backend path found in SHIM_BACKEND_PATH_PATTERNS=$BACKEND_PATH_PATTERNS" >&2
        fi
      }
      ;;
    denoAudit)
      [[ "$run_deno_audit" = "1" ]] && {
        if [[ -n "$BACKEND_DIR" ]] && [[ -d "$BACKEND_DIR/server" ]]; then
          echo "Deno audit..."
          (cd "$BACKEND_DIR/server" && deno audit)
        else
          echo "Skipping Deno audit: backend server dir not found under detected backend path." >&2
        fi
      }
      ;;
    aiReview)
      [[ "$run_ai_review" = true ]] && {
        echo "AI Review..."
        bash "$ROOT_DIR/scripts/ai-code-review.sh"
      }
      ;;
    explanationCheck)
      [[ "$run_explanation_check_rc" = "1" ]] && [[ "$run_explanation_check" = true ]] && {
        echo "Full Explanation check..."
        bash "$ROOT_DIR/scripts/ai-explanation-check.sh"
      }
      ;;
    i18nCheck)
      [[ "$run_i18n_check_rc" = "1" ]] && [[ "$run_i18n_check" = true ]] && {
        echo "i18n check..."
        node "$ROOT_DIR/scripts/i18n-check.js"
      }
      ;;
    updateReadme)
      [[ "$run_update_readme" = "1" ]] && {
        echo "Update README..."
        if [[ -f "$ROOT_DIR/node_modules/shimwrappercheck/scripts/update-readme.js" ]]; then
          node "$ROOT_DIR/node_modules/shimwrappercheck/scripts/update-readme.js"
        elif [[ -f "$ROOT_DIR/scripts/update-readme.js" ]]; then
          node "$ROOT_DIR/scripts/update-readme.js"
        else
          echo "Skipping Update README: no scripts/update-readme.js (use shimwrappercheck script or add own)." >&2
        fi
      }
      ;;
    sast)
      if [[ "$run_sast_rc" = "1" ]] && [[ "$run_sast" = true ]]; then
        echo "Semgrep..."
        semgrep_targets=()
        if [[ -n "${SHIM_SEMGREP_TARGETS:-}" ]]; then
          IFS=',' read -r -a raw_semgrep_targets <<< "$SHIM_SEMGREP_TARGETS"
          for raw_target in "${raw_semgrep_targets[@]}"; do
            target="$(trim "$raw_target")"
            [[ -n "$target" ]] && [[ -d "$ROOT_DIR/$target" ]] && semgrep_targets+=("$target")
          done
        else
          for default_target in apps packages scripts src dashboard supabase; do
            [[ -d "$ROOT_DIR/$default_target" ]] && semgrep_targets+=("$default_target")
          done
        fi
        [[ "${#semgrep_targets[@]}" -eq 0 ]] && semgrep_targets=(".")

        semgrep_args=(
          scan
          --config auto
          --error
          --exclude .git
          --exclude node_modules
          --exclude .next
          --exclude dist
          --exclude build
          --exclude .venv-semgrep
          --exclude .codex-home
          --exclude .shim
          --exclude .shimwrapper
        )
        [[ "${SHIM_SEMGREP_NO_GIT_IGNORE:-0}" == "1" ]] && semgrep_args+=(--no-git-ignore)
        semgrep_args+=("${semgrep_targets[@]}")

        if command -v semgrep >/dev/null 2>&1; then
          set +e
          semgrep_output="$(SEMGREP_ENABLE_VERSION_CHECK=0 PYTHONWARNINGS=ignore semgrep "${semgrep_args[@]}" 2>&1)"
          semgrep_rc=$?
          set -e
          semgrep_output="$(printf '%s\n' "$semgrep_output" | sed '/x509\.decoding/d')"
          [[ -n "$semgrep_output" ]] && echo "$semgrep_output"
          if [[ $semgrep_rc -ne 0 ]]; then
            if echo "$semgrep_output" | grep -Eqi 'empty trust anchors|Failed to create system store X509 authenticator'; then
              if [[ "$allow_environment_skips" == "1" ]]; then
                echo "Skipping Semgrep: local CA trust store unavailable." >&2
              else
                echo "Semgrep failed: local CA trust store unavailable (set SHIM_ALLOW_ENVIRONMENT_SKIPS=1 to allow skip)." >&2
                return "$semgrep_rc"
              fi
            else
              return "$semgrep_rc"
            fi
          fi
        elif npm exec --yes semgrep -- --version >/dev/null 2>&1; then
          npx semgrep "${semgrep_args[@]}"
        else
          echo "Skipping Semgrep: not installed (pip install semgrep or npx semgrep)." >&2
        fi
      fi
      ;;
    gitleaks)
      if [[ "$run_gitleaks_rc" = "1" ]] && [[ "$run_gitleaks" = true ]]; then
        echo "Gitleaks..."
        if command -v gitleaks >/dev/null 2>&1; then
          gitleaks_opts="detect --no-git --source . --verbose"
          [[ -f "$ROOT_DIR/.gitleaks.toml" ]] && gitleaks_opts="detect --config $ROOT_DIR/.gitleaks.toml --no-git --source . --verbose"
          # shellcheck disable=SC2086
          gitleaks $gitleaks_opts
        else
          echo "Skipping Gitleaks: not installed (e.g. brew install gitleaks)." >&2
        fi
      fi
      ;;
    licenseChecker)
      if [[ "$run_license_checker_rc" = "1" ]] && [[ "$run_license_checker" = true ]]; then
        echo "license-checker..."
        npx license-checker --summary 2>/dev/null || true
      fi
      ;;
    architecture)
      if [[ "$run_architecture_rc" = "1" ]] && [[ "$run_architecture" = true ]]; then
        if [[ -f "$ROOT_DIR/.dependency-cruiser.json" ]]; then
          echo "Architecture (dependency-cruiser)..."
          depcruise_entry="src"
          [[ -d "$ROOT_DIR/dashboard" ]] && [[ ! -d "$ROOT_DIR/src" ]] && depcruise_entry="dashboard"
          npx depcruise "$depcruise_entry" --output-type err
        else
          echo "Skipping Architecture: .dependency-cruiser.json not found." >&2
        fi
      fi
      ;;
    complexity)
      if [[ "$run_complexity_rc" = "1" ]] && [[ "$run_complexity" = true ]]; then
        echo "Complexity (eslint-plugin-complexity)..."
        complexity_targets=()
        [[ -d "$ROOT_DIR/apps" ]] && complexity_targets+=("apps")
        [[ -d "$ROOT_DIR/packages" ]] && complexity_targets+=("packages")
        if [[ "${#complexity_targets[@]}" -eq 0 ]]; then
          echo "Skipping Complexity: no apps/ or packages/ directories found." >&2
          return 0
        fi
        complexity_eslint_cmd=()
        if [[ -x "$ROOT_DIR/apps/dashboard/node_modules/.bin/eslint" ]]; then
          complexity_eslint_cmd=("$ROOT_DIR/apps/dashboard/node_modules/.bin/eslint")
        elif command -v eslint >/dev/null 2>&1; then
          complexity_eslint_cmd=("eslint")
        else
          complexity_eslint_cmd=("npx" "--yes" "eslint@9.39.2")
        fi
        if [[ -f "$ROOT_DIR/eslint.complexity.config.mjs" ]]; then
          "${complexity_eslint_cmd[@]}" --no-config-lookup -c "$ROOT_DIR/eslint.complexity.config.mjs" "${complexity_targets[@]}"
        elif [[ -f "$ROOT_DIR/eslint.complexity.cjs" ]]; then
          "${complexity_eslint_cmd[@]}" --no-eslintrc --ext .js,.jsx -c "$ROOT_DIR/eslint.complexity.cjs" "${complexity_targets[@]}"
        elif [[ -f "$ROOT_DIR/eslint.complexity.json" ]]; then
          "${complexity_eslint_cmd[@]}" --no-eslintrc --ext .js,.jsx -c "$ROOT_DIR/eslint.complexity.json" "${complexity_targets[@]}"
        elif [[ -f "$ROOT_DIR/node_modules/shimwrappercheck/templates/eslint.complexity.json" ]]; then
          "${complexity_eslint_cmd[@]}" --no-eslintrc --ext .js,.jsx -c "$ROOT_DIR/node_modules/shimwrappercheck/templates/eslint.complexity.json" "${complexity_targets[@]}"
        else
          echo "Skipping Complexity: add eslint.complexity.json or install shimwrappercheck and eslint-plugin-complexity." >&2
        fi
      fi
      ;;
    mutation)
      if [[ "$run_mutation_rc" = "1" ]] && [[ "$run_mutation" = true ]]; then
        if [[ -f "$ROOT_DIR/stryker.config.json" ]]; then
          echo "Mutation (Stryker)..."
          npx stryker run
        else
          echo "Skipping Mutation: stryker.config.json not found." >&2
        fi
      fi
      ;;
    e2e)
      if [[ "$run_e2e_rc" = "1" ]] && [[ "$run_e2e" = true ]]; then
        if [[ -f "$ROOT_DIR/playwright.config.ts" ]] || [[ -f "$ROOT_DIR/playwright.config.js" ]]; then
          echo "E2E (Playwright)..."
          npx playwright test
        else
          echo "Skipping E2E: no Playwright config found." >&2
        fi
      fi
      ;;
    ruff)
      if [[ "$run_ruff_rc" = "1" ]] && [[ "$run_ruff" = true ]]; then
        if command -v ruff >/dev/null 2>&1; then
          has_py="$(find . \
            \( -path './.git' -o -path './node_modules' -o -path './.venv-semgrep' -o -path './.codex-home' -o -path './.next' -o -path './dist' -o -path './build' \) -prune \
            -o -type f \( -name '*.py' -o -name 'pyproject.toml' -o -name 'requirements.txt' \) -print -quit 2>/dev/null)"
          if [[ -n "$has_py" ]]; then
            echo "Ruff (Python)..."
            ruff check .
            ruff format --check .
          else
            echo "Skipping Ruff: no Python files, pyproject.toml or requirements.txt found." >&2
          fi
        else
          echo "Skipping Ruff: not installed (e.g. pip install ruff, brew install ruff)." >&2
        fi
      fi
      ;;
    shellcheck)
      if [[ "$run_shellcheck_rc" = "1" ]] && [[ "$run_shellcheck" = true ]]; then
        if command -v shellcheck >/dev/null 2>&1; then
          shfiles=$(find . -name '*.sh' ! -path './node_modules/*' ! -path './.git/*' 2>/dev/null)
          if [[ -n "$shfiles" ]]; then
            echo "Shellcheck..."
            echo "$shfiles" | xargs shellcheck
          else
            echo "Skipping Shellcheck: no .sh files found." >&2
          fi
        else
          echo "Skipping Shellcheck: not installed (e.g. brew install shellcheck)." >&2
        fi
      fi
      ;;
    *)
      echo "Unknown check id: $id" >&2
      return 1
      ;;
  esac
  return $?
}

FAILED_CHECKS=()
OVERALL_RC=0

run_step() {
  local id="$1"
  should_run_check "$id" || return 0

  set +e
  run_one "$id"
  local rc=$?
  set -e

  if [[ $rc -ne 0 ]]; then
    FAILED_CHECKS+=("$id")
    if [[ "$continue_on_error" == "1" ]]; then
      echo "Check failed (continuing): $id" >&2
      return 0
    fi
    return "$rc"
  fi

  return 0
}

run_sequence() {
  local ids=("$@")
  local id=""
  for id in "${ids[@]}"; do
    if ! run_step "$id"; then
      return 1
    fi
  done
  return 0
}

if [[ -n "${SHIM_CHECK_ORDER:-}" ]]; then
  echo "Running checks in My Checks order..."
  ORDER=()
  for id in $(echo "$SHIM_CHECK_ORDER" | tr ',' ' '); do
    ORDER+=("$id")
  done
  set +e
  run_sequence "${ORDER[@]}"
  seq_rc=$?
  set -e
  [[ $seq_rc -ne 0 ]] && OVERALL_RC=$seq_rc
else
  DEFAULT_ORDER=()

  if [[ "$run_frontend" = true ]]; then
    echo "Running frontend checks..."
    DEFAULT_ORDER+=(updateReadme prettier lint typecheck projectRules i18nCheck checkMockData viteBuild testRun npmAudit snyk)
  fi

  if [[ "$run_backend" = true ]]; then
    echo "Running backend checks..."
    DEFAULT_ORDER+=(denoFmt denoLint denoAudit)
  fi

  DEFAULT_ORDER+=(ruff shellcheck sast gitleaks licenseChecker architecture complexity mutation e2e)

  if [[ "$run_ai_review" = true ]] && { [[ "$run_frontend" = true ]] || [[ "$run_backend" = true ]]; }; then
    DEFAULT_ORDER+=(aiReview)
  fi

  if [[ "$run_explanation_check" = true ]] && [[ "$run_explanation_check_rc" = "1" ]] && { [[ "$run_frontend" = true ]] || [[ "$run_backend" = true ]]; }; then
    DEFAULT_ORDER+=(explanationCheck)
  fi

  set +e
  run_sequence "${DEFAULT_ORDER[@]}"
  seq_rc=$?
  set -e
  [[ $seq_rc -ne 0 ]] && OVERALL_RC=$seq_rc
fi

run_refactor_orchestration

if [[ "${#FAILED_CHECKS[@]}" -gt 0 ]]; then
  failed_csv="$(printf '%s\n' "${FAILED_CHECKS[@]}" | paste -sd, -)"
  echo "Failed checks: $failed_csv" >&2
  OVERALL_RC=1
fi

if [[ $OVERALL_RC -ne 0 ]]; then
  exit "$OVERALL_RC"
fi
