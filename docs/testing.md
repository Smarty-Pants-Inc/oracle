# Testing quickstart

- Unit/type tests: `pnpm test` (Vitest) and `pnpm run check` (typecheck).
- Gemini unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web`.
- Browser smokes: `pnpm test:browser` (builds, verifies the installed official Codex Chrome plugin/extension/native host path, then delegates the live ChatGPT smoke to a nested Codex `@chrome` task). Requires Chrome running with the Codex Chrome Extension enabled and a signed-in ChatGPT session.
- Live API smokes: `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:live` (excludes OpenAI pro), `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:pro` (OpenAI pro live). Expect real usage/cost.
- Gemini web (cookie) live smoke: `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts` (requires a signed-in Chrome profile at `gemini.google.com`).
- MCP focused: `pnpm test:mcp` (builds then stdio smoke via mcporter).
- The browser smoke no longer launches Chrome or opens a DevTools port. If it fails before touching ChatGPT, fix the Codex Chrome plugin availability reported by `scripts/test-browser.ts` instead of falling back to cookie or DevTools harnesses.
