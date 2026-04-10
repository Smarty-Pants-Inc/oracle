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
- From the parent `smarty-code` repo, run `./scripts/update-forks-oracle.sh` to fetch `origin` and `upstream`, merge `upstream/main`, run the carried checks, rebuild `dist`, and smoke-test the CLI.
- Use `./scripts/update-forks-all.sh` from the parent repo when you want to sync both Oracle and Codex together. That helper only supports clean `main` branches; use the per-fork helper for custom branches or refs.
- Do not push by default. Only pass `--push` when explicitly asked.

## Required Verification

- `pnpm test`
- `pnpm run check`
- `pnpm run build`
- `node dist/bin/oracle-cli.js --version`

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

## Runtime Notes

- Session state lives under `~/.oracle/sessions`; reattach instead of re-running long browser sessions.
- `forks/oracle` is the preferred local Oracle checkout for Codex supervisor work. `external/oracle` is an upstream reference/fallback, not the carried patch stack.
