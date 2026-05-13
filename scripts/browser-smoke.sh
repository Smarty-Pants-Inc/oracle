#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[browser-smoke] delegated to official Codex Chrome plugin harness"
exec pnpm exec tsx "$ROOT/scripts/test-browser.ts" "$@"
