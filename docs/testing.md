# Testing quickstart

- Unit/type tests: `pnpm test` (Vitest) and `pnpm run check` (typecheck).
- Gemini unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web`.
- Browser smokes: `pnpm test:browser` builds, verifies the installed Open
  Browser Use CLI/MCP path, and runs the live ChatGPT open/read/finalize smoke
  through `obu mcp` when the Open Browser Use Chrome extension/native host
  backend is connected. Use `pnpm test:browser:live` or
  `ORACLE_OPEN_BROWSER_USE_REQUIRE_LIVE=1 pnpm test:browser` when live browser
  execution must fail closed. Requires Chrome running with Open Browser Use
  enabled and a signed-in ChatGPT session.
- Live API smokes: `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:live` (excludes OpenAI pro), `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:pro` (OpenAI pro live). Expect real usage/cost.
- Gemini web (cookie) live smoke: `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts` (requires a signed-in Chrome profile at `gemini.google.com`).
- MCP focused: `pnpm test:mcp` (builds then stdio smoke via mcporter).
- The browser smoke does not call Oracle's legacy browser engine. If
  `pnpm test:browser` prints `ORACLE_OPEN_BROWSER_USE_READY_OK`, the Open
  Browser Use CLI/MCP path is installed but the live backend was unavailable;
  run `open-browser-use setup`, install/enable the extension, restart Chrome if
  requested, and rerun the live-required command. Do not fall back to cookie or
  DevTools harnesses.
