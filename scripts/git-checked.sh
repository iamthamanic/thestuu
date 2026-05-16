#!/usr/bin/env bash
set -euo pipefail

exec "$(pwd)/node_modules/shimwrappercheck/scripts/git-checked.sh" "$@"
