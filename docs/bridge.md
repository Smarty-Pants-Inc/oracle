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
3. The Linux client fetches `GET /transactions/<transactionToken>/artifacts/<artifactId>` with the same transaction-v3 connection key, writes to `~/.oracle/sessions/<sessionId>/artifacts/`, verifies size and SHA-256, validates ZIP structure when applicable, and only then publishes the final path in session metadata.
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
- Generates a 32-byte CSPRNG access key encoded as exactly 64 lowercase hexadecimal characters (stored to disk; not printed unless you ask).
- Starts an SSH reverse tunnel so the Linux host can reach the Windows service at `127.0.0.1:9473`. Native Windows OpenSSH runs one tracked `ssh -N -R ... -o ExitOnForwardFailure=yes` tunnel child; it does not use `ControlMaster`, `ControlPath`, or `ssh -O`. POSIX hosts retain the control-socket flow.
- Writes `~/.oracle/bridge-connection.json` (contains host + token) only after the local controller is ready and a bounded, short-lived `ssh -W` stdio probe reaches the forwarded Linux loopback port and verifies its transaction-v3 health proof with the generated key. Probe processes are closed after each attempt. A live reverse-tunnel process by itself is never readiness.

Useful flags:

- Bind a different local port: `--bind 127.0.0.1:9474`
- Use a specific key: `--token <64-lowercase-hex-characters>`
- Allow predecessor text-only clients with a separate bearer: `--legacy-token <distinct-64-lowercase-hex-characters>`
- Print the connection string (includes token): `--print`
- Print only the token: `--print-token`
- SSH port/custom args: `--ssh-extra-args "-p 2222"`. On native Windows, multiplexing/control options (`-M`, `-S`, `-O`, `ControlMaster`, `ControlPath`, and `ControlPersist`) are rejected; use key or agent authentication supported by Windows OpenSSH.
- Background mode (writes pid/log files under `~/.oracle`): `--background`. The detached child receives both bridge credentials through a bounded one-shot inherited pipe, not through argv or environment; the parent closes the pipe and publishes the connection/PID files only after nonce-authenticated child readiness. The child reports ready only after the same authenticated remote-side forward probe succeeds; failure tears down the SSH child and preserves prior published state.

## 2) Linux: configure the client once

Copy the connection artifact from Windows to Linux (example from Windows → Linux):

```powershell
scp "$env:USERPROFILE\.oracle\bridge-connection.json" user@your-linux-host:~/bridge-connection.json
```

Then on the Linux host:

```bash
oracle bridge client --connect ~/bridge-connection.json
```

This writes the loopback endpoint and modern v3 key to `browser.remoteHost` and `browser.remoteToken`. Bridge client rejects non-loopback connection artifacts and any key that is not exactly 64 lowercase hexadecimal characters, even with `--no-test`.

Now browser runs automatically route through the host:

```bash
oracle --engine browser -p "hello" --file README.md
```

### Upgrade from the immediately preceding 32-hex default

The immediately preceding base release generated 16-byte bridge credentials encoded as 32 lowercase hexadecimal characters. Current remote transport requires 32-byte credentials encoded as 64 lowercase hexadecimal characters. The old value is never sent or accepted as a modern or legacy credential.

Use this rotate/clear/re-import sequence:

1. On the browser host, stop the predecessor bridge, upgrade Oracle, and rotate the credential by starting the current host with `oracle bridge host --token auto` (plus the same `--ssh` options you normally use). This writes a new 64-character credential to `~/.oracle/bridge-connection.json`.
2. On the client, remove `browser.remoteHost` and `browser.remoteToken` from `~/.oracle/config.json`, then clear any shell overrides:

   ```bash
   unset ORACLE_REMOTE_HOST ORACLE_REMOTE_TOKEN
   ```

3. Copy the newly generated host artifact to the client again, then re-import it:

   ```bash
   oracle bridge client --connect ~/bridge-connection.json
   ```

Until this migration is complete, remote browser use fails closed with rotation guidance. Dormant remote settings do not block `oracle --status`, `oracle --session <id>`, `oracle --render-markdown`, `oracle --copy-markdown`, `oracle bridge claude-config --local-browser`, explicit API CLI runs, or MCP consults explicitly using `engine: "api"`.

### Explicit mixed-version text bridge

There is no silent downgrade.

- **New client → predecessor host:** provide a tokenless loopback endpoint plus a distinct legacy bearer and explicit opt-in. Connection tokens are never repurposed as bearer credentials:

  ```bash
  oracle bridge client \
    --connect 127.0.0.1:9473 \
    --legacy-token <64-lowercase-hex-characters> \
    --allow-legacy-text-protocol
  ```

  To configure modern v3 plus fallback concurrently, use a normal connection artifact and pass a legacy token that differs from its modern connection token.

- **Predecessor client → new host:** start the new host with `--legacy-token <distinct-64-lowercase-hex-characters>`, then configure the predecessor client with that bearer. Never give the predecessor client the modern `--token` value; modern HMAC root keys are not bearer credentials.

Persistent compatibility uses `browser.remoteLegacyToken` plus `browser.remoteAllowLegacyTextProtocol: true`. Environment-only clients use `ORACLE_REMOTE_LEGACY_TOKEN` plus `ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL=1`. Modern and explicitly enabled legacy credentials must each be exactly 64 lowercase hexadecimal characters and must remain distinct. Legacy runs return text only and require manual artifact transfer.

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

Transaction-v3 request signatures are accepted only when their issued-at timestamp is no more than **5 minutes old** and no more than **30 seconds in the future** according to the bridge host. If authenticated requests fail with `401 invalid_request_authentication`, synchronize both machines with NTP (or the platform time service), then retry so Oracle creates a fresh timestamp, nonce, and signature; replaying the rejected request does not repair clock skew.

## Security notes

- Tokens are not printed by default.
- Detached background child process arguments and environment do not contain either bridge credential; credentials cross only the inherited one-shot pipe and are never copied to the log.
- The connection artifact and config file contain secrets; keep them private (Oracle writes them with restrictive permissions on Unix).
- A legacy bearer must be distinct from the modern v3 HMAC root key; the modern key is never sent or accepted as bearer authentication.
- Durable remote-transaction records use a separate OS-account-scoped integrity key (by default `~/.oracle/.remote-transaction-integrity.key`), not the mutable bridge connection credential. Oracle requires mode `0600` and owner-private directories on Unix. On Windows it invokes the fixed native Windows PowerShell executable directly, never through `PATH` or an intermediate command shell; the UTF-16LE encoded command carries configured paths in a separate base64 payload so path text is never appended as PowerShell source. The command removes inherited access and establishes an exact protected DACL for the controller user plus `SYSTEM` and built-in Administrators on the key directory/file and the bounded transaction-store tree before key or record use, while the controller pins the protected root generations across ACL application and store inventory; the closed tree is revalidated once per bounded store operation. Rotating the connection credential does not re-key persisted records or invalidate pending cleanup or recovery authority.
- Each transaction envelope authenticates its format version, monotonic revision, key identifier, resolved store directory, trusted filename token, exact payload length, and exact payload bytes before Oracle parses or uses the record. Within one controller lifetime, Oracle remembers the exact authenticated head for each transaction and rejects an older signed revision or any different digest before it can authorize recovery, target closure, artifact cleanup, or retention deletion. Unsigned, modified, wrong-key, renamed, copied, or controller-head-stale records are preserved in hidden `.quarantine` files when safe containment is possible.
- The integrity key and transaction store share the operating-system account as their durable trust principal. The HMAC detects corruption and non-key substitution; Unix mode `0600` and the Windows owner-private DACL do **not** isolate files from other code running as the same account. They do not protect against root/Administrator/`SYSTEM`, same-account memory or IPC access, or an offline rollback that restores a matching older key and record snapshot. Different unprivileged Windows accounts are excluded from the live key/store tree before authority is parsed or mutated. Envelope revision freshness is controller-lifetime only and does not provide cross-restart rollback protection: after a cold restart, Oracle authenticates the current disk record and seeds the new controller's head from it so recovery remains available. Run the bridge host under a dedicated OS account when mutually untrusted code shares a machine.
- Do not delete or rotate the integrity key while canonical or quarantined transaction records remain, and do not move the store directory without an explicit offline migration. If records exist but their integrity key is missing, startup fails closed and preserves them. Pre-integrity unsigned records are never trusted or automatically migrated: archive them for manual review outside the live store, then start Oracle with an empty transaction store to create a new key.
- Bridge does **not** extract/decrypt cookies from arbitrary profiles; the Windows machine keeps the authenticated session locally.
