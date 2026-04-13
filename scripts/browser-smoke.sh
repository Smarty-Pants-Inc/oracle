#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_URL="${ORACLE_CHATGPT_PROJECT_URL:-}"
HIDDEN_PROFILE="${ORACLE_BROWSER_PROFILE_DIR:-$HOME/.oracle/browser-profile-hidden}"
CMD=(
  node "$ROOT/dist/bin/oracle-cli.js"
  --engine browser
  --wait
  --heartbeat 0
  --timeout 900
  --browser-input-timeout 120000
  --browser-manual-login
  --browser-model-strategy select
  --browser-hide-window
  --chatgpt-url "$PROJECT_URL"
)
FAST_MODEL="${ORACLE_BROWSER_SMOKE_FAST_MODEL:-gpt-5.2}"
THINKING_MODEL="${ORACLE_BROWSER_SMOKE_THINKING_MODEL:-gpt-5.4}"
PRO_MODEL="${ORACLE_BROWSER_SMOKE_PRO_MODEL:-gpt-5.4-pro}"

[[ -n "$PROJECT_URL" ]] || {
  echo "error: ORACLE_CHATGPT_PROJECT_URL must be set to a ChatGPT /g/.../project URL for browser smoke tests." >&2
  exit 1
}

node -e '
const raw = process.argv[1];
let parsed;
try {
  parsed = new URL(raw);
} catch {
  process.exit(1);
}
const host = parsed.hostname.toLowerCase();
const validHost = host === "chatgpt.com" || host === "chat.openai.com";
const validPath = /^\/g\/[^/]+\/project\/?$/.test(parsed.pathname);
process.exit(validHost && validPath ? 0 : 1);
' "$PROJECT_URL" || {
  echo "error: ORACLE_CHATGPT_PROJECT_URL must be a ChatGPT /g/.../project URL (got: $PROJECT_URL)." >&2
  exit 1
}

export ORACLE_ALLOW_VISIBLE_CHROME=0
export ORACLE_BROWSER_PROFILE_DIR="$HIDDEN_PROFILE"

tmpfile="$(mktemp -t oracle-browser-smoke)"
echo "smoke-attachment" >"$tmpfile"

echo "[browser-smoke] fast upload attachment (non-inline)"
"${CMD[@]}" --model "$FAST_MODEL" --browser-attachments always --prompt "Read the attached file and return exactly one markdown bullet '- upload: <content>' where <content> is the file text." --file "$tmpfile" --slug browser-smoke-upload --force

echo "[browser-smoke] fast simple"
"${CMD[@]}" --model "$FAST_MODEL" --prompt "Return exactly one markdown bullet: '- pro-ok'." --slug browser-smoke-pro --force

echo "[browser-smoke] fast with attachment preview (inline)"
"${CMD[@]}" --model "$FAST_MODEL" --browser-inline-files --prompt "Read the attached file and return exactly one markdown bullet '- file: <content>' where <content> is the file text." --file "$tmpfile" --slug browser-smoke-file --preview --force

echo "[browser-smoke] thinking model simple"
"${CMD[@]}" --model "$THINKING_MODEL" --prompt "Return exactly one markdown bullet: '- thinking-ok'." --slug browser-smoke-thinking-model --force

echo "[browser-smoke] pro standard markdown check"
"${CMD[@]}" --model "$PRO_MODEL" --prompt "Return two markdown bullets and a fenced code block labeled js that logs 'thinking-ok'." --slug browser-smoke-thinking --force

echo "[browser-smoke] reattach flow after controller loss"
slug="browser-reattach-smoke"
meta="$HOME/.oracle/sessions/$slug/meta.json"
logfile="$(mktemp -t oracle-browser-reattach)"

# Start a browser run in the background and wait for runtime hints to appear.
"${CMD[@]}" --model "$PRO_MODEL" --prompt "Return exactly 'reattach-ok'." --slug "$slug" --browser-keep-browser --heartbeat 0 --timeout 900 --force >"$logfile" 2>&1 &
runner_pid=$!

runtime_ready=0
for _ in {1..40}; do
  if [ -f "$meta" ] && node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.browser?.runtime?.chromePort){process.exit(0);}process.exit(1);" "$meta"; then
    runtime_ready=1
    break
  fi
  sleep 1
done

if [ "$runtime_ready" -ne 1 ]; then
  echo "[browser-smoke] reattach: runtime hint never appeared"
  cat "$logfile"
  kill "$runner_pid" 2>/dev/null || true
  exit 1
fi

# Give ChatGPT time to finish after we have a runtime hint.
sleep 30

# Simulate controller loss.
kill "$runner_pid" 2>/dev/null || true
wait "$runner_pid" 2>/dev/null || true

reattach_log="$(mktemp -t oracle-browser-reattach-log)"
if ! node "$ROOT/dist/bin/oracle-cli.js" session "$slug" --render-plain >"$reattach_log" 2>&1; then
  echo "[browser-smoke] reattach: session command failed"
  cat "$reattach_log"
  exit 1
fi

if ! grep -q "reattach-ok" "$reattach_log"; then
  echo "[browser-smoke] reattach: expected response not found"
  cat "$reattach_log"
  exit 1
fi

# Cleanup Chrome if it was left running.
chrome_pid=$(node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync('$meta','utf8'));if(j.browser?.runtime?.chromePid){console.log(j.browser.runtime.chromePid);} }catch{}")
if [ -n "${chrome_pid:-}" ]; then
  kill "$chrome_pid" 2>/dev/null || true
fi
rm -rf "$HOME/.oracle/sessions/$slug" "$logfile" "$reattach_log"

rm -f "$tmpfile"
