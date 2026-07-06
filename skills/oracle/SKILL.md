---
name: oracle
description: Use the @steipete/oracle CLI to bundle a prompt plus the right files and get a second-model review (API or browser) for debugging, refactors, design checks, or cross-validation.
---

# Oracle (CLI) — best use

Oracle bundles your prompt + selected files into one “one-shot” request so another model can answer with real repo context (API or browser automation). Treat outputs as advisory: verify against the codebase + tests.

## Main use case (browser, GPT‑5.4 Pro)

Default workflow here: `--engine browser` with GPT‑5.4 Pro in ChatGPT. This is the “human in the loop” path: it can take ~10 minutes to ~1 hour; expect a stored session you can reattach to.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Model: GPT‑5.4 Pro (either `--model gpt-5.4-pro` or a ChatGPT picker label like `--model "5.4 Pro"`)
- Attachments: directories/globs + excludes; avoid secrets.

## Golden path (fast + reliable)

1. Pick a tight file set (fewest files that still contain the truth).
2. Preview what you’re about to send (`--dry-run` + `--files-report` when needed).
3. Run in browser mode for the usual GPT‑5.4 Pro ChatGPT workflow; use API only when you explicitly want it.
4. If the run detaches/timeouts: reattach to the stored session (don’t re-run).

## Commands (preferred)

- Show help (once/session):
  - `npx -y @steipete/oracle --help`

- Preview (no tokens):
  - `npx -y @steipete/oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `npx -y @steipete/oracle --dry-run full -p "<task>" --file "src/**"`

- Token/cost sanity:
  - `npx -y @steipete/oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run (main path; long-running is normal):
  - `npx -y @steipete/oracle --engine browser --model gpt-5.4-pro -p "<task>" --file "src/**"`

- Manual paste fallback (assemble bundle, copy to clipboard):
  - `npx -y @steipete/oracle --render --copy -p "<task>" --file "src/**"`
  - Note: `--copy` is a hidden alias for `--copy-markdown`.

## Attaching files (`--file`)

`--file` accepts files, directories, and globs. You can pass it multiple times; entries can be comma-separated.

- Include:
  - `--file "src/**"` (directory glob)
  - `--file src/index.ts` (literal file)
  - `--file docs --file README.md` (literal directory + file)

- Exclude (prefix with `!`):
  - `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`

- Defaults (important behavior from the implementation):
  - Default-ignored dirs: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp` (skipped unless you explicitly pass them as literal dirs/files).
  - Honors `.gitignore` when expanding globs.
  - Does not follow symlinks (glob expansion uses `followSymbolicLinks: false`).
  - Dotfiles are filtered unless you explicitly opt in with a pattern that includes a dot-segment (e.g. `--file ".github/**"`).
  - Default cap: files > 512 MB are rejected unless you lower or raise `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` in `~/.oracle/config.json`.

## Budget + observability

- Target: keep total input under ~196k tokens.
- Use `--files-report` (and/or `--dry-run json`) to spot the token hogs before spending.
- If you need hidden/advanced knobs: `npx -y @steipete/oracle --debug-help`.

## Engines (API vs browser)

- Auto-pick: uses `api` when `OPENAI_API_KEY` is set, otherwise `browser`.
- Browser engine supports GPT + Gemini only; use `--engine api` for Claude/Grok/Codex or multi-model runs.
- **API runs require explicit user consent** before starting because they incur usage costs.
- Browser attachments:
  - `--browser-attachments auto|never|always` (auto pastes inline up to ~60k chars then uploads).
- Remote browser host (signed-in machine runs automation):
  - Host: `oracle serve --host 0.0.0.0 --port 9473 --token <secret>`
  - Client: `oracle --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`

## Browser Failure Handling

For browser-mode failures, inspect Oracle's structured session metadata before guessing from logs. Agent-facing blockers include:

- `login_required`: the browser profile is not signed into ChatGPT; ask the user to sign in through the Oracle automation profile or provide active cookies/session before retrying.
- `scope_mismatch`: a requested ChatGPT project/thread URL redirected out of scope; repair the URL/account access and do not fall back to root ChatGPT.
- `selector_drift`: ChatGPT likely changed DOM semantics/selectors; inspect the captured evidence and update the semantic probe.
- `captcha`, `permission`, `rate_limit`, `browser_unavailable`, `timeout`, `model_unavailable`, `unsupported_endpoint`: fix the named blocker before rerunning.

Prompt submission is not successful just because a click or Enter key was sent. Treat the prompt as accepted only after semantic UI evidence such as a new turn, stop control, thinking/status/progress/shimmer state, cleared/disabled composer, or assistant turn. If ChatGPT changes, extend these probes and preserve `BrowserAutomationError.details` (`stage`, `code`, `signals`, `blockers`, `evidence`) instead of adding blind waits.

When a browser run is intentionally pinned to a ChatGPT project (`/g/.../project`) or thread (`/c/...`), fail closed if ChatGPT redirects to root chat. Root fallback can pollute the user's main chat list and hides account/project-access regressions.

Live ChatGPT browser smokes are opt-in: default to dry-runs, unit tests, and session metadata checks unless the user explicitly approves a live send. Project scoping alone is not a non-pollution proof. Approved live project smokes that send a prompt must also verify cleanup: use `--browser-archive auto` for one-shot smokes, use `--browser-archive always` only when intentionally forcing cleanup outside the default one-shot policy, and check session metadata for `browser.archive.archived: true` after any created `/c/...` conversation. If login/scope/model checks fail before a conversation exists, report the structured blocker instead of retrying. Never clean up previously created ChatGPT test conversations without explicit approval for the conversation ids/URLs.

## Sessions + slugs (don’t lose work)

- Stored under `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).
- Browser runs save durable files under `~/.oracle/sessions/<id>/artifacts/`, including `transcript.md`, Deep Research reports, and downloaded ChatGPT-generated images when available.
- Full approved ChatGPT thread export is a separate read-only command, not a prompt run:
  - `oracle chatgpt-export --target-url "https://chatgpt.com/c/<conversation-id>"`
  - It attaches to an existing approved tab and captures the page's own reload-time backend response for that exact conversation id.
  - It does not send prompts, archive/delete/share chats, read cookies/localStorage/profile stores, or browse unrelated history.
- Runs may detach or take a long time (browser + GPT‑5.4 Pro often does). If the CLI times out: don’t re-run; reattach.
  - List: `oracle status --hours 72`
  - Attach: `oracle session <id> --render`
- Use `--slug "<3-5 words>"` to keep session IDs readable.
- Duplicate prompt guard exists; use `--force` only when you truly want a fresh run.

## Prompt template (high signal)

Oracle starts with **zero** project knowledge. Assume the model cannot infer your stack, build tooling, conventions, or “obvious” paths. Include:

- Project briefing (stack + build/test commands + platform constraints).
- “Where things live” (key directories, entrypoints, config files, dependency boundaries).
- Exact question + what you tried + the error text (verbatim).
- Constraints (“don’t change X”, “must keep public API”, “perf budget”, etc).
- Desired output (“return patch plan + tests”, “list risky assumptions”, “give 3 options with tradeoffs”).

### “Exhaustive prompt” pattern (for later restoration)

When you know this will be a long investigation, write a prompt that can stand alone later:

- Top: 6–30 sentence project briefing + current goal.
- Middle: concrete repro steps + exact errors + what you already tried.
- Bottom: attach _all_ context files needed so a fresh model can fully understand (entrypoints, configs, key modules, docs).

If you need to reproduce the same context later, re-run with the same prompt + `--file …` set (Oracle runs are one-shot; the model doesn’t remember prior runs).

## Safety

- Don’t attach secrets by default (`.env`, key files, auth tokens). Redact aggressively; share only what’s required.
- Prefer “just enough context”: fewer files + better prompt beats whole-repo dumps.
