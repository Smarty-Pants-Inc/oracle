# Oracle Fork Workflow

This checkout is the carried local Oracle fork for `smarty-code`.
The parent `smarty-code` repo tracks this fork as a gitlink/submodule; move the parent gitlink only when you intentionally want to pin a new Oracle commit there.

## Branches and Remotes

- `origin=https://github.com/smarty-Pants-Inc/oracle.git`
- `upstream=https://github.com/steipete/oracle.git`
- Carried branch: `main`
- Patch-stack policy: committed commits on `main` above `upstream/main` are the real patch stack. Dirty edits are not durable.

## Merge Workflow

- Before merging upstream, run `git status --short`.
- If the repo is dirty, stop and decide whether the current Oracle changes need to be committed first.
- From the parent `smarty-code` repo, run `./scripts/update-forks-oracle.sh` to fetch `origin` and `upstream`, merge `upstream/main`, run the carried checks, rebuild `dist`, smoke-test the CLI, and run hidden live Oracle browser E2E in the Oracle ChatGPT project scope.
- Use `./scripts/update-forks-all.sh` from the parent repo when you want to sync both Oracle and Codex together. That helper only supports clean `main` branches; use the per-fork helper for custom branches or refs.
- Do not push by default. Only pass `--push` when explicitly asked.

## Required Verification

- `pnpm test`
- `pnpm run check`
- `pnpm run build`
- `node dist/bin/oracle-cli.js --version`
- Every upstream sync/update is incomplete until the hidden project-scoped live Oracle browser E2E passes. The canonical path is `./scripts/update-forks-oracle.sh`, which wires that live proof in automatically.

## Browser-Supervisor Changes

- For browser automation, model selection, prompt submission, or supervisor-broker changes, rerun live hidden-browser broker smokes for both:
  - `gpt-5.4-pro`
  - `gpt-5.4` with browser label `Thinking 5.4`
- On this machine, prefer headed hidden Chrome:
  - `--engine browser`
  - `--browser-manual-login`
  - `--browser-model-strategy select`
  - `--browser-hide-window`
- Do not default to true headless here. Cloudflare still makes that path unreliable.

## ChatGPT UI Drift Policy

- Assume the ChatGPT web UI will keep changing. Oracle browser automation should be built to adapt gracefully, not to depend on one frozen page shape.
- Prefer semantic anchors over brittle structure:
  - accessible labels and roles
  - visible text near the control you need
  - URL/runtime/session metadata
  - stable conversation identifiers
- Avoid deep descendant selectors, `nth-child`, transient class names, and assumptions about exact menu nesting unless no better signal exists.
- Use layered fallbacks for critical flows such as thread discovery, model selection, prompt submission, attachment handling, and transcript extraction.
- If a runtime session goes stale, prefer bounded repair and reattach before giving up.
- Fail closed when the target thread, model, or workspace is ambiguous. Never guess which thread to mutate.
- Normalize extracted transcript content through shape-tolerant helpers and strip obvious ChatGPT action chrome/noise before returning text to Codex.
- When a flake is found, fix the generalized helper and add regression coverage for that variant. Do not only patch the one DOM shape that failed today.
- Keep framework testing inside the Oracle ChatGPT project scope so live resilience testing does not pollute the user’s main workspace.
- Keep the browser hidden/backgrounded on this machine. A visible Chrome launch is a regression unless the user is explicitly debugging it.
- Normal non-test usage may still default to the user’s main/root ChatGPT workspace unless they ask for a project or an existing thread there.

## Runtime Notes

- Session state lives under `~/.oracle/sessions`; reattach instead of re-running long browser sessions.
- `forks/oracle` is the preferred local Oracle checkout for Codex supervisor work. `external/oracle` is an upstream reference/fallback, not the carried patch stack.
