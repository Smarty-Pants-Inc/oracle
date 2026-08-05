# Bridge (Windows-hosted ChatGPT session → Linux clients)

Oracle’s bridge workflow lets you keep an authenticated ChatGPT session on a Windows machine while running Oracle (CLI + `oracle-mcp`) from Linux boxes (often over SSH), without exporting browser cookies off Windows.

## Concepts

- **Host (Windows)**: runs `oracle bridge host` and holds the signed-in ChatGPT session.
- **Client (Linux)**: stores the host connection once and routes browser runs (and MCP browser runs) through the host.

## Generated artifact transfer

Bridge runs keep the Windows browser host and Linux client separated while returning ChatGPT-generated files when both sides use transaction v3. The host advertises artifact-transfer support from its authenticated health response. Predecessor text-only hosts remain reachable only through explicit legacy opt-in and a scoped legacy bearer; generated files then require manual copy.

The transfer protocol is pull-based and keeps secrets local to the host:

1. The browser host saves the ChatGPT file to its local session artifacts directory as before.
2. The host emits only a redacted artifact descriptor over the existing NDJSON run stream: artifact id, safe filename, MIME type, byte size, SHA-256, validation status, and coarse source kind. It does not expose cookies, bearer tokens, signed ChatGPT download URLs, or Windows filesystem paths.
3. The Linux client fetches `GET /runs/<runId>/artifacts/<artifactId>` with the same bridge bearer token, writes to `~/.oracle/sessions/<sessionId>/artifacts/`, verifies size and SHA-256, validates ZIP structure when applicable, and only then publishes the final path in session metadata.
4. If transfer fails, Oracle keeps the text response and records a warning with manual fallback instructions. Open the ChatGPT browser on the Windows host, use the visible download button/link in the current assistant response, and copy the file to a cloud-readable path yourself.

Operational notes:

- Run the same patched Oracle version on both Windows host and Linux client before relying on automatic file transfer. Mixed-version text compatibility is fail-closed unless the operator explicitly enables it with a separate predecessor bearer.
- `oracle bridge doctor` prints the negotiated `transaction-v3` or `legacy-text-v1` protocol and reports `Artifact transfer: bridge v1` when the host advertises it, including the maximum artifact size.
- The default bridge transfer size limit is 512 MiB. Larger files stay on the browser host and require manual copy.
- Session inspection prints artifact path, size, SHA-256 prefix, validation status, and transfer status so agents can verify whether the returned path is local to the Linux client.

## 1) Windows: start the host service (recommended)

Run this on the Windows machine that’s signed into ChatGPT:

```powershell
oracle bridge host --token auto --ssh user@your-linux-host
```

What it does:

- Starts a local `oracle serve` instance bound to `127.0.0.1:9473` by default.
- Generates an access token (stored to disk; not printed unless you ask).
- Starts an SSH reverse tunnel so the Linux host can reach the Windows service at `127.0.0.1:9473`.
- Writes a connection artifact to `~/.oracle/bridge-connection.json` (contains host + token).

Useful flags:

- Bind a different local port: `--bind 127.0.0.1:9474`
- Use a specific token: `--token <value>`
- Allow predecessor text-only clients with a separate bearer: `--legacy-token <different-value>`
- Print the connection string (includes token): `--print`
- Print only the token: `--print-token`
- SSH port/custom args: `--ssh-extra-args "-p 2222"`
- Background mode (writes pid/log files under `~/.oracle`): `--background`

## 2) Linux: configure the client once

Copy the connection artifact from Windows to Linux (example from Windows → Linux):

```powershell
scp "$env:USERPROFILE\.oracle\bridge-connection.json" user@your-linux-host:~/bridge-connection.json
```

Then on the Linux host:

```bash
oracle bridge client --connect ~/bridge-connection.json --write-config --test
```

This writes the loopback endpoint and modern v3 key to `browser.remoteHost` and `browser.remoteToken`. Bridge client rejects non-loopback connection artifacts even with `--no-test`.

Now browser runs automatically route through the host:

```bash
oracle --engine browser -p "hello" --file README.md
```

### Explicit mixed-version text bridge

There is no silent downgrade.

- **New client → predecessor host:** provide a tokenless loopback endpoint plus a distinct legacy bearer and explicit opt-in. Connection tokens are never repurposed as bearer credentials:

  ```bash
  oracle bridge client \
    --connect 127.0.0.1:9473 \
    --legacy-token <predecessor-bearer> \
    --allow-legacy-text-protocol \
    --write-config --test
  ```

  To configure modern v3 plus fallback concurrently, use a normal connection artifact and pass a legacy token that differs from its modern connection token.

- **Predecessor client → new host:** start the new host with `--legacy-token <different-predecessor-bearer>`, then configure the predecessor client with that bearer. Never give the predecessor client the modern `--token` value; modern HMAC root keys are not bearer credentials.

Persistent compatibility uses `browser.remoteLegacyToken` plus `browser.remoteAllowLegacyTextProtocol: true`. Environment-only clients use `ORACLE_REMOTE_LEGACY_TOKEN` plus `ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL=1`. Legacy runs return text only and require manual artifact transfer.

## 2b) Linux desktop: local manual-login (no bridge)

If you’re physically on a Linux desktop and just want Oracle to reuse a local signed-in Chrome profile (no Windows bridge):

1. Run a browser session once and sign in when Chrome opens:

```bash
ORACLE_HOME_DIR=~/.oracle-local \
ORACLE_BROWSER_PROFILE_DIR=~/.oracle-local/browser-profile \
oracle --engine browser --browser-manual-login --browser-keep-browser -p "hello"
```

2. After you’re signed in, reuse the same env vars for future runs (no more login prompts).

Optional: use the helper wrapper `scripts/oracle-local-browser.sh` to avoid repeating flags/env vars:

```bash
chmod +x ./scripts/oracle-local-browser.sh
./scripts/oracle-local-browser.sh -p "hello" --file README.md
```

## 3) Codex CLI (MCP) integration

On the Linux machine where Codex runs:

```bash
oracle bridge codex-config
```

Paste the printed snippet into `~/.codex/config.toml`.

## 3b) Claude Code (MCP) integration

On the Linux machine where Claude Code runs:

```bash
oracle bridge claude-config > .mcp.json
```

Then start Claude Code with that config (or register it via `claude mcp add` depending on your setup).

Notes:

- The snippet includes `ORACLE_ENGINE="browser"` so MCP consult calls use browser mode even if `OPENAI_API_KEY` is set.
- By default the snippets replace configured secrets with placeholders. `--print-token` includes the modern token and, when explicit compatibility is enabled, the distinct legacy token plus `ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL=1`.

### macOS local browser: Let Them Fight

If Claude Code and the signed-in Chrome profile are on the same Mac, skip the remote bridge and generate a local config:

```bash
oracle bridge claude-config --local-browser > .mcp.json
```

This points Claude Code at `oracle-mcp`, sets `ORACLE_ENGINE="browser"`, and reuses the shared manual-login profile at `~/.oracle/browser-profile`. From Claude Code, call `consult` with `preset:"chatgpt-pro-heavy"` for the “Let Them Fight” workflow: Claude asks Oracle, Oracle asks ChatGPT Pro Extended in browser mode, and the answer comes back through MCP. Use `dryRun:true` first when you only want to validate the resolved request.

For long Pro runs, keep the Oracle session id visible in the agent transcript and inspect `oracle status` / `oracle session <id>` before retrying. Browser consults may wait on ChatGPT for several minutes; the dry-run/browser control plan is the operator-facing signal for whether Oracle will attach to an existing browser, use remote Chrome, or launch a visible window.

Override local paths when needed:

```bash
oracle bridge claude-config \
  --local-browser \
  --oracle-home-dir ~/.oracle \
  --browser-profile-dir ~/.oracle/browser-profile > .mcp.json
```

## 4) Troubleshooting

Run:

```bash
oracle bridge doctor
```

It checks:

- Whether a loopback remote host and usable modern or explicitly enabled legacy credential are configured
- TCP reachability to the loopback endpoint
- Authenticated protocol negotiation via `GET /health`, including the selected `transaction-v3` or `legacy-text-v1` protocol
- If no remote is configured, it probes local Chrome + cookie DB detection and suggests `--browser-chrome-path` / `--browser-cookie-path`

## Security notes

- Tokens are not printed by default.
- The connection artifact and config file contain secrets; keep them private (Oracle writes them with restrictive permissions on Unix).
- A legacy bearer must be distinct from the modern v3 HMAC root key; the modern key is never sent or accepted as bearer authentication.
- Bridge does **not** extract/decrypt cookies from arbitrary profiles; the Windows machine keeps the authenticated session locally.
