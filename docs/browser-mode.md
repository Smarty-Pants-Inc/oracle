# Browser Mode

Oracle’s `--engine browser` supports three execution paths:

- **ChatGPT launcher mode** (GPT-\* models): Oracle launches a separate hidden Chrome instance and drives the ChatGPT web UI over CDP.
- **ChatGPT remote-CDP mode** (GPT-\* models): Oracle connects only to an explicitly supplied, dedicated browser via `--remote-chrome`.
- **Gemini web mode** (Gemini models): talks directly to `gemini.google.com` using your signed-in Chrome cookies (no ChatGPT automation).

If you’re running Gemini, also see `docs/gemini.md`.

`oracle --engine browser` routes the assembled prompt bundle through the ChatGPT web UI instead of the Responses API. (Legacy `--browser` still maps to `--engine browser`, but it will be removed.) If you omit `--engine`, Oracle first honors `ORACLE_ENGINE`, then any `engine` value in the effective config, including project `.oracle/config.json` files layered over `~/.oracle/config.json`. It auto-picks API when `OPENAI_API_KEY` is available and falls back to browser otherwise. The CLI writes the same session metadata/logs as API runs, and by default pastes the payload into ChatGPT via a temporary Chrome profile (manual-login mode can reuse a persistent automation profile).

`--preview` now works with `--engine browser`: it renders the composed prompt, lists which files would be uploaded vs inlined, and shows the bundle location when bundling is enabled, without launching Chrome.

## Quick example: browser mode with custom cookies

```bash
# Minimal inline-cookies flow: keep ChatGPT logged in without Keychain
jq '.' ~/.oracle/cookies.json  # file must contain CookieParam[]
oracle --engine browser \
  --browser-inline-cookies-file ~/.oracle/cookies.json \
  --model "GPT-5.6 Sol Pro" \
  -p "Run the UI smoke" \
  --file "src/**/*.ts" --file "!src/**/*.test.ts"
```

`~/.oracle/cookies.json` should be a JSON array shaped like:

```json
[
  {
    "name": "__Secure-next-auth.session-token",
    "value": "<token>",
    "domain": "chatgpt.com",
    "path": "/",
    "secure": true,
    "httpOnly": true
  },
  { "name": "_account", "value": "personal", "domain": "chatgpt.com", "path": "/", "secure": true }
]
```

You can pass the same payload inline (`--browser-inline-cookies '<json or base64>'`) or via env (`ORACLE_BROWSER_COOKIES_JSON`, `ORACLE_BROWSER_COOKIES_FILE`). Cloudflare cookies (`cf_clearance`, `__cf_bm`, etc.) are only needed when you hit a challenge.

## Quick example: dedicated background Chrome CDP

Use a separate Oracle-only profile and background app instance. Never point
Oracle at the primary/user browser.

```bash
open -g -j -n "/Applications/Google Chrome.app" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.oracle/browser-profile-hidden" \
  about:blank

oracle --engine browser \
  --remote-chrome 127.0.0.1:9222 \
  --model "GPT-5.6 Sol Pro" \
  -p "Summarize the last assistant response in one paragraph"
```

Notes:

- Local headful launches use the same `open -g -j -n` hidden/background mechanism automatically.
- `--browser-attach-running` is disabled by this fork's background-only policy.
- Remote mode opens a fresh Oracle-owned tab and closes only that tab after a successful run.
- If a dedicated hidden launch cannot be guaranteed, Oracle fails closed instead of using a visible fallback.

## Export an approved existing conversation

`chatgpt-export` preserves one explicitly approved ChatGPT conversation without
sending a prompt:

```bash
oracle chatgpt-export \
  --target-url "https://chatgpt.com/c/<conversation-id>" \
  --remote-chrome 127.0.0.1:9222 \
  --out ~/Documents/chatgpt-conversation-exports/review
```

The command scopes capture to that exact backend conversation URL and writes
raw JSON, normalized JSON, Markdown, a manifest, and checksums. It does not read
cookies, local storage, browser profiles, or unrelated history. Archived targets
are recovered only for the exact approved id and re-archived after export; use
`--no-recover-archived` to disable recovery. `--archive-after-export` is an
explicit mutation that archives an active conversation after a successful export.

## Current Pipeline

1. **Prompt assembly** – we reuse the normal prompt builder (`buildPrompt`) and the markdown renderer. Browser mode pastes the system + user text (no special markers) into the ChatGPT composer and, by default, pastes resolved file contents inline until the total pasted content reaches ~60k characters (then switches to uploads).
2. **Automation stack** – code lives under `src/browser/`:
   - Launcher mode starts a separate hidden macOS Chrome app with `open -g -j -n` and connects with `chrome-remote-interface`.
   - Remote mode connects only to an explicitly supplied dedicated Chrome CDP endpoint and opens an Oracle-owned tab.
   - Launcher mode can optionally copy cookies from the requested browser profile via Oracle’s built-in cookie reader (Keychain/DPAPI aware) so you stay signed in.
   - Navigates to `chatgpt.com`, switches the model to the requested GPT-5.5 / GPT-5.4 / GPT-5.2 variant, optionally activates Deep Research, pastes the prompt, waits for completion, and copies the markdown via the built-in “copy turn” button.
   - Immediately probes the cookie-authenticated `/api/auth/session` endpoint in the ChatGPT tab and checks only whether it contains a user; returned tokens are never logged. If that endpoint is unavailable, Oracle falls back to the legacy `/backend-api/me` probe and a visible composer plus profile or chat-history authentication signals. Auth pages, visible login controls, resolved sessions without a user, composer-only shells, and pages without profile/history signals still fail with login guidance.
   - When `--file` inputs would push the pasted composer content over ~60k characters, we switch to uploading attachments (optionally bundled) and wait for ChatGPT to re-enable the send button before submitting the combined system+user prompt.
   - Launcher mode cleans up the temporary profile unless `--browser-keep-browser` is passed.
3. **Session integration** – browser sessions use the normal log writer, add `mode: "browser"` plus `browser.config/runtime` metadata, and persist Chrome pid/port or websocket attach metadata plus the Oracle-owned target/tab URL for reattach.
4. **Usage accounting** – we estimate input tokens with the same tokenizer used for API runs and estimate output tokens via `estimateTokenCount`. `oracle status` therefore shows comparable cost/timing info even though the call ran through the browser.

### CLI Options

- `--engine browser`: enables browser mode (legacy `--browser` remains as an alias for now). Without `--engine`, Oracle chooses API when `OPENAI_API_KEY` exists, otherwise browser.
- `--browser-chrome-profile`, `--browser-chrome-path`: cookie source + binary override (defaults to the standard `"Default"` Chrome profile so existing ChatGPT logins carry over).
- `--browser-cookie-path`: explicit path to the Chrome/Chromium/Edge `Cookies` SQLite DB. Handy when you launch a fork via `--browser-chrome-path` and want to copy its session cookies; see [docs/chromium-forks.md](chromium-forks.md) for examples.
- `--remote-chrome <host:port>`: connect to a dedicated background Chrome CDP endpoint. `--browser-attach-running` is rejected so Oracle cannot discover or control the primary browser.
- `--chatgpt-url`: override the ChatGPT base URL. Works with the root homepage (`https://chatgpt.com/`), Temporary Chat (`https://chatgpt.com/?temporary-chat=true`), **or** a specific workspace/folder link such as `https://chatgpt.com/g/.../project`. `--browser-url` stays as a hidden alias.
- `--browser-timeout`, `--browser-input-timeout`, `--browser-attachment-timeout`: `1200s (20m)`/`60s`/`45s` defaults. The attachment timeout controls upload/readiness before clicking Send and can also be set with `ORACLE_BROWSER_ATTACHMENT_TIMEOUT` or `browser.attachmentTimeoutMs`. Durations accept `ms`, `s`, `m`, or `h` and can be chained (`1h2m10s`).
- `--browser-recheck-delay`, `--browser-recheck-timeout`: after an assistant timeout, wait the delay, revisit the conversation, and retry capture (default recheck timeout 120s). Useful for Pro runs that finish later.
- `--browser-reuse-wait`: wait for a shared Chrome profile (DevToolsActivePort) to appear before launching a new Chrome. Helps multiple parallel runs reuse the same Chromium instance.
- `--browser-profile-lock-timeout`: wait for the shared manual-login profile lock before sending, serializing parallel runs that share a Chrome profile.
- `--browser-max-concurrent-tabs`: soft limit for simultaneous ChatGPT tabs sharing one manual-login profile (default `3`). Set `ORACLE_BROWSER_MAX_CONCURRENT_TABS` for a per-host default; explicit CLI/config values win. Additional runs wait up to the browser timeout for a slot and log `[browser] Waiting for ChatGPT browser slot...`.
- `--browser-auto-reattach-delay`, `--browser-auto-reattach-interval`, `--browser-auto-reattach-timeout`: after a timeout, start periodic auto-reattach attempts (delay before first attempt, repeat interval, per-attempt timeout). This lets Oracle keep polling a finished Pro response without manual `oracle session` runs.
- `--heartbeat`: browser mode uses this interval to emit long-run ChatGPT status. When ChatGPT exposes a Thinking/Reasoning disclosure, Oracle opens it and logs only liveness metadata such as sidecar presence, UI progress percentage, elapsed time, and last-change age. It does not log the reasoning text.
- If an assistant response still times out (common with long Pro runs), Oracle marks the session as an incomplete capture, stores reattach/runtime diagnostics, and keeps enough browser metadata for `oracle session <id>` to recover the final answer. Visible ChatGPT rate-limit, temporary-unavailable, and authentication/challenge warnings are included in the error and session metadata instead of being reduced to a generic timeout. Increase `--browser-timeout` only when the browser session is truly unrecoverable.
- `--browser-model-strategy <select|current|ignore>`: control ChatGPT model selection. `select` (default) switches to the requested model; `current` keeps the active model and logs its label; `ignore` skips the picker entirely. (Ignored for Gemini web runs.)
- Temporary Chat can reduce account-sidebar clutter for one-shot browser consults, but it is a different ChatGPT workflow: Oracle skips archive attempts there and the local transcript/artifacts are the durable record. Verify live behavior before relying on Project Sources, Deep Research reports, or multi-turn persistence.
- `--browser-thinking-time <light|standard|extended|heavy>`: set the ChatGPT thinking-time intensity (Thinking/Pro models only). You can also set a default in `~/.oracle/config.json` via `browser.thinkingTime`.
- GPT-5.5 Pro Extended is verified from the selected item in ChatGPT's standalone Pro/Thinking effort pill or compatible Intelligence/model-picker menu. A run **fails closed** if Extended cannot be confirmed rather than silently submitting at a weaker effort. Detection failures write a bounded, redacted model-picker diagnostic to the normal session log.
- `--browser-research deep`: activate ChatGPT Deep Research before submitting the prompt. Use this for broad public-web research and final cited reports, not as a replacement for GPT-5.x Pro Heavy code review or pure reasoning.
- `--browser-follow-up <prompt>`: submit another prompt in the same ChatGPT conversation after the initial answer. Repeat the flag for multi-turn reviews such as “challenge your recommendation”, “compare against this constraint”, then “give the final decision”. Deep Research has its own report lifecycle, so browser follow-ups are rejected when `--browser-research deep` is enabled.
- `--followup <session-id>`: reopen the exact saved ChatGPT conversation from a completed browser session. Oracle inherits the parent browser profile, configuration, and model, then verifies the thread and prior turns before submitting.
- `--browser-archive <auto|always|never>`: archive completed ChatGPT conversations after local artifacts are saved. The default `auto` archives only successful one-shot chats and skips project, Deep Research, multi-turn, failed, and incomplete sessions.
- `--browser-port <port>` (alias: `--browser-debug-port`; env: `ORACLE_BROWSER_PORT`/`ORACLE_BROWSER_DEBUG_PORT`): pin the DevTools port (handy on WSL/Windows firewalls). When omitted, a random open port is chosen.
- `ORACLE_CHATGPT_ACCOUNT_EMAIL`: exact saved-account email to select if ChatGPT shows its “Welcome back” account picker. Set it on the machine running browser automation. Oracle never logs the address; without it, Oracle selects only a single unambiguous saved account and fails closed when several are present.
- Local ChatGPT launches are hidden automatically. `--browser-hide-window` remains accepted for compatibility; `--browser-keep-browser` and the global `-v/--verbose` flag control retention and diagnostics.
- `--copy-profile <dir>`: copy a signed-in Chrome user-data directory (e.g. `"$HOME/Library/Application Support/Google/Chrome"`) to a throwaway profile and run against it, reusing your live ChatGPT session with no manual sign-in. Oracle copies the profile recorded as active in `Local State`; pass `--browser-chrome-profile <name>` to select another direct child profile. The copy is launched with the real Keychain (not mocked) so its encrypted cookies decrypt, and is always deleted afterward—including setup/launch failures, incomplete captures, Cloudflare challenges, and interrupts. Copied-profile runs cannot be kept or reattached. Not compatible with `--browser-keep-browser`, `--browser-manual-login`, `--browser-attach-running`, `--remote-chrome`, or `--remote-host`, and fails fast if the required `Local State` cannot be copied. macOS/Linux; requires `rsync`.
- `--browser-url`: override ChatGPT base URL if needed.
- `--browser-attachments <auto|never|always>`: control how `--file` inputs are delivered in browser mode. Default `auto` pastes text contents inline up to ~60k characters and uploads larger or raw files. `never` requires inline-compatible text inputs and rejects raw/binary files.
- `--browser-inline-files`: alias for `--browser-attachments never` (forces inline paste; never uploads attachments).
- `--browser-bundle-files`: bundle all resolved attachments into a single temp file before uploading (only used when uploads are enabled/selected).
- `--browser-bundle-format <auto|text|zip>`: choose the bundle format. `auto` uses a text bundle for text-only inputs and a byte-preserving ZIP when bundled inputs include raw files; `text` keeps the single Markdown-style text bundle; `zip` archives the original file bytes. ZIP bundle inputs are capped at 128 MiB because bundle creation is in-memory.
- sqlite bindings: automatic rebuilds now require `ORACLE_ALLOW_SQLITE_REBUILD=1`. Without it, the CLI logs instructions instead of running `pnpm rebuild` on your behalf.
- `--model`: `gpt-5.6-sol-pro` is this fork's logical default. Browser mode selects ChatGPT's `Pro` target; API mode sends `gpt-5.6-sol` with Pro reasoning. Use `gpt-5.6-sol` to pin base Sol. GPT-5.2 base, Instant, and Thinking aliases remain available through the API but browser mode rejects them because ChatGPT retired those picker entries.
- Cookie sync is mandatory—if we can’t copy cookies from Chrome, the run exits early. By default Oracle copies a small ChatGPT auth/Cloudflare allowlist to avoid oversized request headers; use `--browser-cookie-names` only when you need to override that set. Use the hidden `--browser-allow-cookie-errors` flag only when you’re intentionally running logged out (it skips the early exit but still warns).
- `--browser-attach-running` is rejected by the fork's background-only policy. Use `--remote-chrome` only with a dedicated Oracle browser endpoint; never target the primary/user browser.
- Experimental cookie controls (hidden flags/env):
  - `--browser-cookie-names <comma-list>` or `ORACLE_BROWSER_COOKIE_NAMES`: override the default allowlist of cookies to sync. Useful when ChatGPT changes auth cookie names.
  - `--browser-cookie-wait <ms|s|m>`: if cookie sync fails or returns no cookies, wait once and retry (helps when macOS Keychain prompts are slow).
  - `--browser-inline-cookies <jsonOrBase64>` or `ORACLE_BROWSER_COOKIES_JSON`: skip Chrome/keychain and set cookies directly. Payload is a JSON array of DevTools `CookieParam` objects (or the same, base64-encoded). At minimum you need `name`, `value`, and either `url` or `domain`; we infer `path=/`, `secure=true`, `httpOnly=false`.
  - `--browser-inline-cookies-file <path>` or `ORACLE_BROWSER_COOKIES_FILE`: load the same payload from disk (JSON or base64 JSON). If no args/env are provided, Oracle also auto-loads `~/.oracle/cookies.json` or `~/.oracle/cookies.base64` when present.
  - Practical minimal set that keeps ChatGPT logged in and avoids the workspace picker: `__Secure-next-auth.session-token` (include `.0`/`.1` variants) and `_account` (active workspace/account). Cloudflare proofs (`cf_clearance`, `__cf_bm`/`_cfuvid`/`CF_Authorization`/`__cflb`) are only needed when a challenge is active. In practice our allowlist pulls just two cookies (session token + `_account`) and works; add the Cloudflare names if you hit a challenge.
  - Inline payload shape example (we ignore extra fields like `expirationDate`, `sameSite`, `hostOnly`):
    ```json
    [
      {
        "name": "__Secure-next-auth.session-token",
        "value": "<token>",
        "domain": "chatgpt.com",
        "path": "/",
        "secure": true,
        "httpOnly": true,
        "expires": 1771295753
      },
      {
        "name": "_account",
        "value": "personal",
        "domain": "chatgpt.com",
        "path": "/",
        "secure": true,
        "httpOnly": false,
        "expires": 1770702447
      }
    ]
    ```

All options are persisted with the session so restarts (`oracle restart <id>`) reuse the same automation settings.

### Deep Research mode

Use `--browser-research deep` when the task needs broad web discovery, source comparison, or a cited report:

```bash
oracle --engine browser \
  --browser-manual-login \
  --browser-research deep \
  -p "Research the current browser support for WebGPU in enterprise-managed Chrome and cite sources."
```

Oracle activates ChatGPT Deep Research through the composer tools menu, recognizing both the `Deep research` label and current `Get a detailed report` menu variants. It waits for the research plan to auto-confirm, logs high-level progress, then captures the final report from the Deep Research report surface instead of trusting the assistant tool-call wrapper.

If ChatGPT initially exposes only `Called tool` / `Used tool`, Oracle treats that as an incomplete capture for Deep Research rather than a final answer. Reattach the existing session with `oracle session <id> --render` so Oracle can recover the lazy-loaded report from the existing Chrome tab; do not rerun the research unless the browser session is unrecoverable.

Deep Research is browser-only. It does not use connected apps in v1; give it public-web scope, uploaded files, and any domain/source guidance in the prompt. For deep thinking over code or architecture without web search, prefer a normal browser run with a Pro/Thinking model and `--browser-thinking-time heavy`.

Completed browser sessions also save durable artifacts under `~/.oracle/sessions/<id>/artifacts/`. Deep Research writes the extracted report to `deep-research-report.md`, and every browser run writes `transcript.md` with the prompt, final answer, conversation URL, and saved artifact references. Use `--write-output <path>` when you also need a copy of just the final answer at a specific path.

When ChatGPT generates downloadable files in the assistant response (for example a ZIP, wheel, source distribution, CSV, or PDF), Oracle saves those files beside the transcript before any archive attempt. The downloader is intentionally narrow: it only follows ChatGPT-owned file/download URLs from the assistant response and uses `sandbox:/mnt/data/...` links as source metadata and filename hints, not as arbitrary fetch targets. External links in the response are left in the transcript but are not downloaded. In bridge mode, a patched Windows host advertises artifact-transfer capability through `/health`; the Linux client then pulls each saved file over the authenticated bridge endpoint, stores it under the Linux session `artifacts/` directory, and verifies safe filename, byte size, SHA-256, and ZIP structure where applicable. If either side is older or transfer validation fails, the text response still completes and Oracle prints a manual-copy fallback instead of leaking host paths or signed download URLs.

### Conversation archiving

Browser mode keeps the local session as the source of truth, so Oracle can optionally archive the ChatGPT conversation after a run. The default `--browser-archive auto` archives successful non-Temporary, non-Deep-Research, non-multi-turn one-shot chats, including project chats, after `transcript.md`, generated artifacts, the final answer, and the conversation URL are saved locally.

When a one-shot run is interrupted after ChatGPT has created a `/c/...` conversation, Oracle also makes a best-effort archive attempt so failed response capture does not leave active-sidebar residue. Oracle does not auto-archive Temporary Chat, Deep Research, multi-turn sessions, or failures that happen before a conversation URL exists. Use `--browser-archive never` to disable archiving, or `--browser-archive always` when you explicitly want a browser conversation archived outside the default one-shot policy. Archived chats are still visible and manageable from ChatGPT's own archive UI.

### ChatGPT Project Sources

ChatGPT Project Sources can act as explicit shared context for project workflows where chats should not implicitly share memory. This is especially useful with Developer Mode / Memory Off: separate chats do not see each other's conversation history, but they can read files attached to the Project Sources tab.

Oracle exposes a narrow, non-destructive v1:

```bash
# Preview the upload plan without touching ChatGPT
oracle project-sources add \
  --chatgpt-url "https://chatgpt.com/g/g-p-example/project" \
  --browser-manual-login \
  --file docs/architecture.md \
  --dry-run

# List current sources
oracle project-sources list \
  --chatgpt-url "https://chatgpt.com/g/g-p-example/project" \
  --browser-manual-login

# Append files to the Sources tab
oracle project-sources add \
  --chatgpt-url "https://chatgpt.com/g/g-p-example/project" \
  --browser-manual-login \
  --file docs/architecture.md docs/decisions.md
```

This command uses browser automation but does not select a model, start a consult, or send a prompt. It only opens the Project Sources surface, lists existing files, or appends new files. Destructive operations such as delete, replace, and sync are intentionally left out until the UI path is safer and better covered by live tests.

### Multi-turn browser consults

Use browser follow-ups when a one-shot review would be too easy for the model to answer shallowly. Oracle keeps the same ChatGPT conversation open, waits for each answer, then submits the next follow-up:

```bash
oracle --engine browser \
  --model gpt-5.6-sol-pro \
  --browser-thinking-time heavy \
  -p "Review this migration plan and identify the top risks." \
  --file docs/migration-plan.md \
  --browser-follow-up "Challenge your previous recommendation. What would fail in production?" \
  --browser-follow-up "Now give the final decision with the smallest safe next step."
```

The CLI output and saved `transcript.md` include each captured turn. For PR validation, compare a one-shot run with the same initial prompt against a two-turn run that asks the model to challenge itself; record concrete differences such as additional failure modes, test cases, or rollback steps rather than claiming a fixed quality percentage.

Guardrails for agents:

- Use one-shot browser runs for narrow bugs, exact file sets, quick code review, or when the expected answer is a short decision.
- Use explicit follow-ups for ambiguous architecture, competing options, product tradeoffs, or review flows where a challenge pass and final recommendation are useful.
- Use Deep Research for broad public-web research that needs citations; Deep Research has its own lifecycle and is not combined with browser follow-ups.
- Oracle never invents follow-ups automatically. Agents may suggest a short follow-up sequence, but the caller must pass each prompt explicitly with `--browser-follow-up` or `browserFollowUps`.

### ChatGPT generated images

When ChatGPT returns downloadable generated images in browser mode, Oracle downloads them using the active browser cookies and records them as session artifacts. To choose an output path, pass `--generate-image <file>`:

```bash
oracle --engine browser \
  --browser-manual-login \
  --model "GPT-5.6 Sol Pro" \
  --generate-image /tmp/oracle-image.png \
  -p "Create a simple product icon on a transparent background."
```

If ChatGPT returns multiple images, the first image saves to the requested path and the rest save as numbered siblings. Without `--generate-image`, Oracle writes images to the session `artifacts/` directory.

MCP agents should prefer the `chatgpt_image` tool. It wraps the same behavior with a smaller input shape, uploads reference files by default, and returns saved files in `structuredContent.images`. Advanced callers can still pass `generateImage` to `consult` directly.

### Manual login mode (persistent profile, no cookie copy)

Use `--browser-manual-login` when cookie decrypt is blocked (e.g., Windows app-bound cookies) or you prefer to sign in explicitly. You can also make it the default via `browser.manualLogin` in `~/.oracle/config.json`.

```bash
oracle --engine browser \
  --browser-manual-login \
  --browser-keep-browser \
  --model "GPT-5.6 Sol Pro" \
  -p "Say hi"
```

- Oracle launches Chrome headful with a persistent automation profile at `~/.oracle/browser-profile` (override with `ORACLE_BROWSER_PROFILE_DIR` or `browser.manualLoginProfileDir` in `~/.oracle/config.json`).
- Log into chatgpt.com in that window the first time; Oracle polls until the session is active, then proceeds.
- Reuse the same profile on subsequent runs (no re-login unless the session expires).
- Add `--browser-keep-browser` (or config `browser.keepBrowser=true`) when doing the initial login/setup or debugging so the Chrome window stays open after that run. A later normal run, or `--no-browser-keep-browser`, changes the shared direct-run owner back to close on its final tab lease; the profile remains on disk. The remote `oracle serve` bootstrap is separately service-owned, so direct-run flags cannot override its preserved owner.
- Cookie copy is skipped by default in this mode. To automate manual-login runs, set `browser.manualLoginCookieSync=true` in `~/.oracle/config.json` to seed the persistent profile from your existing Chrome cookies; inline cookies apply when cookie sync is enabled.
- If Chrome is already running with that profile and DevTools remote debugging enabled (see `DevToolsActivePort` in the profile dir), you can reuse it instead of relaunching by pointing Oracle at it with `--remote-chrome <host:port>`.
- Remote Chrome runs also participate in tab-slot coordination when paired with `--browser-manual-login` and a shared manual-login profile.

### Concurrent agents and long Pro runs

When Codex, Claude Code, or another Oracle caller share the same manual-login profile, each browser run now acquires a tab slot before opening a ChatGPT tab. The default allows three simultaneous ChatGPT tabs; the fourth caller waits instead of failing because another agent is already using the browser. This is most useful for long Pro/Thinking runs where one agent may wait for a response while another agent needs to start a separate consult.

Use `--browser-max-concurrent-tabs <n>`, `browser.maxConcurrentTabs`, or `ORACLE_BROWSER_MAX_CONCURRENT_TABS` to tune the soft limit. Precedence is explicit CLI/config value, then environment, then the default of `3`; invalid or non-positive environment values fall back instead of disabling the cap. Keep the value modest: too many concurrent ChatGPT tabs can make the UI unstable or trigger account-side throttling. Oracle also serializes manual-login Chrome startup for the shared profile, then reuses the first reachable DevTools session instead of racing multiple Chrome launches against the same `user-data-dir`. The short profile lock still serializes the send/upload moment so separate agents do not type into the same composer.

For live concurrency smoke, the most stable path is one already-running signed-in Chrome with remote debugging enabled, plus `--remote-chrome <host:port>`. Direct parallel launch is supported defensively, but a persistent shared Chrome gives clearer ownership and avoids account/login churn across agents.

## Remote Chrome Sessions (headless/server workflows)

Oracle can reuse an already-running Chrome/Edge instance on another machine by tunneling over the Chrome DevTools Protocol. This is handy when:

- Your CLI runs on a headless server (Linux/macOS CI, remote mac minis, etc.) but you want the browser UI to live on a desktop where you can see uploads or respond to Captcha challenges.
- You want to keep a single signed-in profile open (e.g., Windows VM with company SSO) while sending prompts from other hosts.

### 1. Start Chrome with remote debugging enabled

On the machine that should host the browser window:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/path/to/profile \
  --profile-directory='Default'
```

Notes:

- Any Chromium flavor works (Chrome, Edge, Vivaldi, etc.)—just ensure CDP is exposed on a reachable host:port. Linux distributions often call the binary `google-chrome-stable`. On macOS you can run `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- `--remote-debugging-address=0.0.0.0` is required if the CLI connects from another machine. Lock it down behind a VPN or SSH tunnel if the network is untrusted.
- Keep this browser window open and signed into ChatGPT; Oracle will reuse that session and **will not** copy cookies over the wire.

### 2. Point Oracle at the remote browser

From the machine running `oracle`:

```bash
oracle --engine browser \
  --remote-chrome 192.168.1.10:9222 \
  --prompt "Summarize the latest incident doc" \
  --file docs/incidents/latest.md
```

Key behavior:

- Use IPv6 by wrapping the host in brackets, e.g. `--remote-chrome "[2001:db8::1]:9222"`.
- Local-only flags like `--browser-headless`, `--browser-hide-window`, `--browser-keep-browser`, and `--browser-chrome-path` are ignored because Oracle no longer launches Chrome. You still get verbose logging, model switching, attachment uploads, and markdown capture.
- Cookie sync is skipped automatically (the remote browser already has cookies). If you need inline cookies, use them on the machine that’s actually running Chrome.
- Oracle opens a dedicated CDP target (new tab) for each run and closes it afterward so your existing tabs stay untouched.
- When remote runs are served by an Oracle host with a manual-login profile, the host-side tab lease registry applies the same concurrent tab limit.
- Attachments are transferred via CDP: Oracle reads each file locally, base64-encodes it, and uses `DataTransfer` inside the remote browser to populate the upload field. Files larger than 512 MB are rejected.
- When the remote WebSocket disconnects, Oracle errors with “Remote Chrome connection lost…” so you can re-run after restarting the browser.

### 3. Troubleshooting

- Run `scripts/test-remote-chrome.ts <host> [port]` to sanity-check connectivity (`npx tsx scripts/test-remote-chrome.ts my-host 9222`).
- If you target IPv6 without brackets (e.g., `2001:db8::1:9222`), the CLI rejects it—wrap the address like `[2001:db8::1]:9222`.
- Ensure firewalls allow inbound TCP to the debugging port and that you’re not behind a captive proxy stripping WebSocket upgrades.
- Because we do not control the remote lifecycle, Chrome stays running after the session. Shut it down manually when you’re done or remove `--remote-debugging-port` to stop exposing CDP.

### Remote Service Mode (`oracle serve`)

Use the built-in service when Chrome should remain on a remote Mac. Oracle remote HTTP transport is plaintext and therefore **loopback-only**; cross-machine access must use an SSH tunnel.

1. **Start the host on loopback**

   ```bash
   oracle serve --host 127.0.0.1 --port 9473 --token <64-lowercase-hex-characters>
   ```

   Oracle launches Chrome and starts the authenticated HTTP/SSE API. `--token` is required, must be exactly 64 lowercase hexadecimal characters (a 32-byte key), and must be supplied out of band; Oracle never logs the modern v3 HMAC root key. Use `--port` to select a fixed port. Non-loopback binds such as `0.0.0.0` are rejected because verified TLS is not implemented.

2. **Create the client-side SSH tunnel**

   ```bash
   ssh -N -L 9473:127.0.0.1:9473 user@remote-mac
   ```

   Keep that SSH process running. The local `127.0.0.1:9473` endpoint is now carried to the remote host's loopback service.

3. **Run from the client**

   ```bash
   oracle --engine browser \
     --remote-host 127.0.0.1:9473 \
     --remote-token <64-lowercase-hex-characters> \
     --prompt "Summarize the incident doc" \
     --file docs/incidents/latest.md
   ```

   Store the same loopback host and 64-character lowercase hexadecimal key in `browser.remoteHost` / `browser.remoteToken`, or use `ORACLE_REMOTE_HOST` / `ORACLE_REMOTE_TOKEN`. Cookies remain on the browser host. Remote runs force `--wait` so the client can stream output and complete transaction settlement.

4. **Stop the host**

   `Ctrl+C` shuts down the HTTP server and Chrome. Every restart requires an explicit `--token`; reuse or rotate the key through your secret distribution path.

#### Migration from direct LAN endpoints

Direct plaintext LAN access is no longer supported. Replace `oracle serve --host 0.0.0.0` and client VM/LAN addresses with a loopback bind plus SSH `-L` (or `oracle bridge host --ssh ...`). Both server binds and client endpoints reject non-loopback addresses. There is no TLS escape hatch in this release.

#### Explicit mixed-version text compatibility

Secure defaults never downgrade. A new client may contact a predecessor text-only host only with both a scoped legacy bearer and the explicit opt-in flag:

```bash
oracle --engine browser \
  --remote-host 127.0.0.1:9473 \
  --remote-legacy-token <64-lowercase-hex-characters> \
  --allow-legacy-text-protocol \
  --prompt "Text-only compatibility run"
```

Omit `--remote-token` when the predecessor host has no modern v3 key. The equivalent persistent settings are `browser.remoteLegacyToken` and `browser.remoteAllowLegacyTextProtocol`; the env equivalents are `ORACLE_REMOTE_LEGACY_TOKEN` and `ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL=1`. The explicitly enabled legacy bearer must also be exactly 64 lowercase hexadecimal characters.

For an old client contacting a new host, start the new host with a **distinct** legacy bearer:

```bash
oracle serve --host 127.0.0.1 --port 9473 \
  --token <64-lowercase-hex-characters> \
  --legacy-token <distinct-64-lowercase-hex-characters>
```

Configure the old client with only the predecessor bearer. The modern HMAC root key is never accepted as a bearer token. Legacy mode is text-only: generated files require manual transfer, and transaction-v3 generation-bound recovery is unavailable.

## Limitations / Follow-Up Plan

- **Attachment lifecycle** – in `auto` mode we prefer inlining files into the composer (fewer moving parts). When we do upload, each `--file` path is uploaded separately (or bundled) so ChatGPT can ingest filenames/content. The automation waits for uploads to finish (send button enabled, upload chips visible) before submitting. When inline paste is rejected by ChatGPT (too large), Oracle retries automatically with uploads.
- **Model picker drift** – we rely on heuristics to pick GPT-5.6 / GPT-5.5 / GPT-5.4 / GPT-5.2 variants. If OpenAI changes the DOM we need to refresh the selectors quickly. Consider snapshot tests or a small “self check” command.
- **Non-mac platforms** – local headful ChatGPT launch fails closed because the fork cannot guarantee a hidden window. Use a dedicated `--remote-chrome` endpoint instead.
- **Streaming UX** – browser runs cannot stream tokens, so we emit heartbeat/status logs while waiting. Investigate whether we can stream clipboard deltas via mutation observers for a closer UX.

## Testing Notes

- ChatGPT automation smoke: `pnpm test:browser` (Open Browser Use CLI/MCP
  readiness, plus live ChatGPT open/read/finalize smoke through `obu mcp` when
  the Open Browser Use backend is connected). Use `pnpm test:browser:live` to
  require the live smoke.
- Upload automation smoke: `scripts/browser-smoke-upload-only.sh` validates
  the Open Browser Use file chooser upload path against a local page. Chrome
  must allow file URL access for the Open Browser Use extension.
- Gemini web (cookie) smoke: `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts` (requires a signed-in Chrome profile at `gemini.google.com`)
- `pnpm test --filter browser` does not exist yet; manual runs with `--engine browser -v` are the current validation path.
- Most legacy browser-engine lifting lives under `src/browser/`. The local
  Chrome smoke now validates through Open Browser Use MCP first; do not use the
  old cookie/DevTools smoke as substitute evidence.
