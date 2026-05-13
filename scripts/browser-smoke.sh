#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[browser-smoke] delegated to Open Browser Use MCP harness"
exec pnpm exec tsx "$ROOT/scripts/test-browser.ts" "$@"
