#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[browser-smoke-upload-only] delegated to Open Browser Use MCP harness"
ORACLE_OPEN_BROWSER_USE_REQUIRE_LIVE=1 \
ORACLE_OPEN_BROWSER_USE_UPLOAD_SMOKE=1 \
ORACLE_OPEN_BROWSER_USE_SKIP_CHATGPT_SMOKE=1 \
  exec pnpm exec tsx "$ROOT/scripts/test-browser.ts" "$@"
