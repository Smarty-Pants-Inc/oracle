# Testing quickstart

- Static and unit checks: `pnpm check` and `pnpm test`.
  `pnpm vitest run tests/browser/openBrowserUse.test.ts tests/browser/profileState.test.ts tests/browser/chatgptAccountRouter.test.ts tests/browser/conversationTurns.test.ts tests/browser/reattach.test.ts tests/browser/liveTabs.test.ts tests/browser/chatgptExport.test.ts tests/browser/chromeLifecycle.test.ts tests/cli/followup.test.ts tests/cli/chatgptExport.test.ts tests/cli/chatgptExportCommand.test.ts tests/cli/browserTabs.test.ts tests/cli/browserTabsObu.test.ts tests/cli/browserTabsRecover.test.ts tests/oracle/agentDiagnostics.test.ts`.
- `pnpm test:browser` is the legacy isolated Chrome/CDP smoke. It sends live
  ChatGPT prompts and does not validate the wrapper-routed main-Chrome path. Run
  it only with explicit approval for those model turns.
- Main-Chrome bridge preflight: run `oracle accounts` through the installed
  wrapper. It checks the Open Browser Use SDK/native-host connection and fixed
  route labels without sending a prompt or proving that either login is valid.
- This fork pins `open-browser-use-sdk` `0.1.41`; the live extension/native host
  must use the matching `open-browser-use` CLI `0.1.41`. Installing or repairing
  it with `npm install -g open-browser-use@0.1.41` and `open-browser-use setup`
  requires operator approval. Do not fall back to cookie or DevTools harnesses.
- Live account switching, prompt submission, follow-up, harvest, export, and
  cleanup are opt-in supervised trials. Confirm the exact account, workspace,
  prompt, scope, and cleanup policy before every model send.
- Upload smoke: `scripts/browser-smoke-upload-only.sh` verifies file chooser
  upload against a local test page. Chrome must allow file URL access for the
  Open Browser Use extension.
- Gemini unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web`.
- Live API smokes: `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:live` (excludes
  OpenAI Pro) and `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:pro` (OpenAI
  Pro live). Expect real usage and cost.
- Gemini web live smoke: `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts`
  (requires a signed-in Chrome profile at `gemini.google.com`).
- MCP focused: `pnpm test:mcp` (builds, then runs the stdio smoke through
  mcporter).
