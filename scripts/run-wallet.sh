#!/usr/bin/env bash
# Thin wrapper so the skill can invoke the wallet from any working directory.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run)…" >&2
  npm install >&2
fi

exec node wallet.js "$@"
