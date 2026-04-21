# MCP Server

`oracle-mcp` is a minimal MCP stdio server that mirrors the Oracle CLI. It shares session storage with the CLI (`~/.oracle/sessions` or `ORACLE_HOME_DIR`) so you can mix and match: run with the CLI, inspect or re-run via MCP, or vice versa.

## Tools

### `consult`

- Inputs: `prompt` (required), `files?: string[]` (globs), `model?: string` (defaults to CLI), `engine?: "api" | "browser"` (CLI auto-defaults), `slug?: string`.
- Browser-only extras: `browserAttachments?: "auto"|"never"|"always"`, `browserBundleFiles?: boolean`, `browserThinkingTime?: "light"|"standard"|"extended"|"heavy"`, `browserKeepBrowser?: boolean`, `browserModelLabel?: string`.
- Behavior: starts a session, runs it with the chosen engine, returns final output + metadata. Background/foreground follows the CLI (e.g., GPT‑5 Pro detaches by default).
- Logging: emits MCP logs (`info` per line, `debug` for streamed chunks with byte sizes). If browser prerequisites are missing, returns an error payload instead of running.
- Stable cross-repo call shape: `prompt`, `files`, `engine`, `model`, `slug`, `browserAttachments`, `browserBundleFiles`, and `browserThinkingTime`. When another repo invokes MCP, prefer absolute file paths; relative paths resolve from the MCP server working directory.
- Structured success output includes `sessionId` and `status` (plus `output`, and optional per-model metadata). Error payloads do not always include a `sessionId`; early validation failures and late metadata-read failures can return MCP errors without structured session metadata.

### `sessions`

- Inputs: `{id?, hours?, limit?, includeAll?, detail?}` mirroring `oracle status` / `oracle session`.
- Behavior: without `id`, returns a bounded list of recent sessions. With `id`/slug, returns a summary row; set `detail: true` to fetch full metadata, log, and stored request body.

## Resources

- `oracle-session://{id}/{metadata|log|request}` — read-only resources that surface stored session artifacts via MCP resource reads.

## Background / detach behavior

- Same as the CLI: heavy models (e.g., GPT‑5 Pro) detach by default; reattach via `oracle session <id>` / `oracle status`. MCP does not expose extra background flags.

## Launching & usage

- Installed from npm:
  - One-off: `npx @steipete/oracle oracle-mcp`
  - Global: `oracle-mcp`
- From the repo (contributors):
  - `pnpm build`
  - `pnpm mcp` (or `oracle-mcp` in the repo root)
  - From the `smarty-code` parent repo: `cd forks/oracle && node dist/bin/oracle-mcp.js`
- mcporter example (stdio):
  ```json
  {
    "name": "oracle",
    "type": "stdio",
    "command": "npx",
    "args": ["@steipete/oracle", "oracle-mcp"]
  }
  ```
- Project-scoped Claude (.mcp.json) example:
  ```json
  {
    "mcpServers": {
      "oracle": { "type": "stdio", "command": "npx", "args": ["@steipete/oracle", "oracle-mcp"] }
    }
  }
  ```
- Bridge helper snippets:
  - Codex CLI: `oracle bridge codex-config`
  - Claude Code: `oracle bridge claude-config`
- Tools and resources operate on the same session store as `oracle status|session`.
- Defaults (model/engine/etc.) come from your Oracle CLI config; see `docs/configuration.md` or `~/.oracle/config.json`.

## External callers

- For external callers such as `smarty-agents`, treat `consult` as the execution boundary and `~/.oracle/sessions/<sessionId>/meta.json` as the canonical receipt boundary.
- API-mode sessions may not have any ChatGPT browser conversation id or URL. For API-mode receipt ingestion, treat `meta.json.id` as the stable Oracle session identity.
- Browser/supervisor sessions should prefer `browser.runtime.conversationId`, `supervisorThread.conversationId`, and the corresponding URLs when those fields are present.
- Completed single-answer sessions should persist `response.assistantOutput` in `meta.json`.
- Assistant-created downloads are stored under `~/.oracle/sessions/<sessionId>/downloads/`.
- `output.log` is diagnostic text, not the structured receipt contract.
- Prefer a deterministic `slug` so the caller can correlate request artifacts, MCP runs, and the stored Oracle session id.
- External callers should not parse `oracle_control` or duplicate Oracle browser/broker logic; hand Oracle the prompt/files, capture the returned `sessionId`, then read receipt/artifact data from the session store.
