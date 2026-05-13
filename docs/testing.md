# Testing quickstart

- Unit/type tests: `pnpm test` (Vitest) and `pnpm run check` (typecheck).
- Gemini unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web`.
- Browser smokes: `pnpm test:browser` builds, verifies the installed official
  Codex Chrome plugin/extension/native host path, and runs the live ChatGPT
  smoke when the current Codex runtime exposes the official `@chrome` browser
  tools. Use `pnpm test:browser:live` or
  `ORACLE_CODEX_CHROME_REQUIRE_LIVE=1 pnpm test:browser` when live browser
  execution must fail closed. Requires Chrome running with the Codex Chrome
  Extension enabled and a signed-in ChatGPT session.
- Live API smokes: `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:live` (excludes OpenAI pro), `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:pro` (OpenAI pro live). Expect real usage/cost.
- Gemini web (cookie) live smoke: `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts` (requires a signed-in Chrome profile at `gemini.google.com`).
- MCP focused: `pnpm test:mcp` (builds then stdio smoke via mcporter).
- The browser smoke no longer launches Chrome or opens a DevTools port. If the
  installed plugin checks pass but `pnpm test:browser` prints
  `ORACLE_CHROME_PLUGIN_READY_OK`, the local Codex CLI has the plugin installed
  but did not expose the official browser tools to nested `codex exec`; rerun in
  a runtime that exposes `@chrome` or use the live-required command above. Do
  not fall back to cookie or DevTools harnesses.
