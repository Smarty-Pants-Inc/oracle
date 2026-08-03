#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD=(node "$ROOT/dist/bin/oracle-cli.js" --engine browser --wait --heartbeat 0 --timeout 900 --browser-input-timeout 120000)
FAST_MODEL="${ORACLE_BROWSER_SMOKE_FAST_MODEL:-gpt-5.5}"
PRO_MODEL="${ORACLE_BROWSER_SMOKE_PRO_MODEL:-gpt-5.5-pro}"

tmpdir="$(mktemp -d -t oracle-browser-smoke)"
tmpfile="$tmpdir/smoke-attachment.txt"
upload_log="$(mktemp -t oracle-browser-smoke-upload-log)"
trap 'rm -rf "$tmpdir" "$upload_log"' EXIT
echo "smoke-attachment" >"$tmpfile"

echo "[browser-smoke] fast upload attachment (non-inline)"
if ! "${CMD[@]}" --model "$FAST_MODEL" --browser-attachments always --prompt "Read the attached file and return exactly one markdown bullet '- upload: <content>' where <content> is the file text." --file "$tmpfile" --slug browser-smoke-upload --force | tee "$upload_log"; then
  exit 1
fi
if ! grep -Eq -- "^[[:space:]]*[-*][[:space:]]+upload:[[:space:]]+smoke-attachment" "$upload_log"; then
  echo "[browser-smoke] upload: expected uploaded file content not found"
  cat "$upload_log"
  exit 1
fi

echo "[browser-smoke] fast simple"
"${CMD[@]}" --model "$FAST_MODEL" --prompt "Return exactly one markdown bullet: '- pro-ok'." --slug browser-smoke-pro --force

echo "[browser-smoke] fast with attachment preview (inline)"
"${CMD[@]}" --model "$FAST_MODEL" --browser-inline-files --prompt "Read the attached file and return exactly one markdown bullet '- file: <content>' where <content> is the file text." --file "$tmpfile" --slug browser-smoke-file --preview --force

echo "[browser-smoke] pro standard markdown check"
"${CMD[@]}" --model "$PRO_MODEL" --prompt "Return two markdown bullets and a fenced code block labeled js that logs 'thinking-ok'." --slug browser-smoke-thinking --force

echo "[browser-smoke] reattach flow after controller loss"
slug="browser-reattach-smoke"
meta="$HOME/.oracle/sessions/$slug/meta.json"
logfile="$(mktemp -t oracle-browser-reattach)"
rm -rf "$HOME/.oracle/sessions/$slug"

# Start a browser run in the background and wait until the prompt is submitted.
"${CMD[@]}" --model "$PRO_MODEL" --prompt "Return exactly 'reattach-ok'." --slug "$slug" --browser-keep-browser --heartbeat 0 --timeout 900 --force >"$logfile" 2>&1 &
runner_pid=$!

runtime_ready=0
for _ in {1..40}; do
  if [ -f "$meta" ] && node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.browser?.runtime?.chromePort && j.browser?.runtime?.promptSubmitted === true){process.exit(0);}process.exit(1);" "$meta"; then
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

# Simulate controller loss.
if ! kill -0 "$runner_pid" 2>/dev/null; then
  echo "[browser-smoke] reattach: controller finished before simulated loss"
  cat "$logfile"
  exit 1
fi
kill "$runner_pid"
wait "$runner_pid" 2>/dev/null || true

if node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.exit(j.status === 'completed' ? 0 : 1);" "$meta"; then
  echo "[browser-smoke] reattach: session completed before controller loss"
  cat "$logfile"
  exit 1
fi

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
if ! grep -q "Reattach succeeded; session marked completed." "$reattach_log"; then
  echo "[browser-smoke] reattach: command rendered without exercising live reattach"
  cat "$reattach_log"
  exit 1
fi

# Cleanup Chrome if it was left running.
chrome_pid=$(node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync('$meta','utf8'));if(j.browser?.runtime?.chromePid){console.log(j.browser.runtime.chromePid);} }catch{}")
if [ -n "${chrome_pid:-}" ]; then
  kill "$chrome_pid" 2>/dev/null || true
fi
rm -rf "$HOME/.oracle/sessions/$slug" "$logfile" "$reattach_log"
