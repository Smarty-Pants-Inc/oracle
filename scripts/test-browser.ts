#!/usr/bin/env tsx
/**
 * Open Browser Use MCP smoke for Oracle browser harnesses.
 *
 * This intentionally does not call Oracle's legacy browser engine. The harness
 * proves the installed Open Browser Use CLI/MCP path, opens a live ChatGPT tab
 * through `obu mcp`, reads page state through MCP CDP, and finalizes the tab.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

const OK_TOKEN = "ORACLE_OPEN_BROWSER_USE_SMOKE_OK";
const READY_TOKEN = "ORACLE_OPEN_BROWSER_USE_READY_OK";
const REQUIRE_LIVE_SMOKE = process.env.ORACLE_OPEN_BROWSER_USE_REQUIRE_LIVE === "1";

type CheckResult = {
  name: string;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type JsonObject = Record<string, unknown>;

function main(): void {
  const obuVersion = runObu(["version"], 10_000);
  if (obuVersion.status !== 0) {
    die(
      [
        "Open Browser Use CLI is not available. Install it with `npm install -g open-browser-use` and run `open-browser-use setup`.",
        commandFailure(obuVersion),
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  console.log(`[browser-test] Open Browser Use CLI: ${obuVersion.stdout.trim()}`);
  runMcpToolListCheck();

  const ping = runObu(["ping"], 15_000);
  if (ping.status !== 0) {
    handleBrowserBackendUnavailable(ping);
    return;
  }
  console.log("[browser-test] Open Browser Use browser backend: ok");

  const info = runObu(["info"], 15_000);
  if (info.status !== 0) {
    die(
      ["Open Browser Use info check failed after ping succeeded.", commandFailure(info)]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }
  console.log("[browser-test] Open Browser Use info: ok");

  const projectUrl =
    normalizeUrl(process.env.ORACLE_CHATGPT_PROJECT_URL) ??
    normalizeUrl(process.env.ORACLE_SUPERVISOR_CHATGPT_URL) ??
    normalizeUrl(process.env.ORACLE_BROWSER_SMOKE_CHATGPT_URL) ??
    "https://chatgpt.com/";

  runMcpBrowserSmoke(projectUrl);
  console.log(`[browser-test] ${OK_TOKEN}`);
}

function runObu(args: string[], timeout: number): CheckResult {
  const command = process.env.OBU_BIN?.trim() || "obu";
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
  });
  return {
    name: `${command} ${args.join(" ")}`,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runMcpToolListCheck(): void {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "oracle-browser-smoke", version: "0" },
    },
  };
  const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const result = spawnSync(process.env.OBU_BIN?.trim() || "obu", ["mcp"], {
    encoding: "utf8",
    input: `${JSON.stringify(initialize)}\n${JSON.stringify(toolsList)}\n`,
    timeout: 5_000,
  });
  const check: CheckResult = {
    name: "obu mcp tools/list",
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
  if (check.status !== 0) {
    die(
      ["Open Browser Use MCP stdio check failed.", commandFailure(check)]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  for (const toolName of ["ping", "open_tab", "cdp", "run_action_plan", "finalize_tabs"]) {
    if (!check.stdout.includes(`"name":"${toolName}"`)) {
      die(
        `Open Browser Use MCP tools/list did not include ${toolName}.\n${tail("stdout", check.stdout)}`,
      );
    }
  }
  console.log("[browser-test] Open Browser Use MCP tools: ok");
}

function runMcpBrowserSmoke(projectUrl: string): void {
  const requests = [
    mcpRequest(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "oracle-browser-smoke", version: "0" },
    }),
    mcpRequest(2, "tools/call", { name: "ping", arguments: {} }),
    mcpRequest(3, "tools/call", { name: "info", arguments: {} }),
    mcpRequest(4, "tools/call", {
      name: "name_session",
      arguments: { name: "Oracle browser smoke - OBU" },
    }),
    mcpRequest(5, "tools/call", { name: "open_tab", arguments: { url: projectUrl } }),
    mcpRequest(6, "tools/call", {
      name: "wait_load",
      arguments: { state: "domcontentloaded" },
    }),
    mcpRequest(7, "tools/call", { name: "page_info", arguments: {} }),
    mcpRequest(8, "tools/call", { name: "finalize_tabs", arguments: { keep: [] } }),
  ];

  const command = process.env.OBU_BIN?.trim() || "obu";
  const result = spawnSync(command, ["mcp"], {
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    timeout: Number.parseInt(process.env.ORACLE_OPEN_BROWSER_USE_TIMEOUT_MS ?? "60000", 10),
  });
  const check: CheckResult = {
    name: `${command} mcp browser smoke`,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
  if (check.status !== 0) {
    die(
      ["Open Browser Use MCP browser smoke failed.", commandFailure(check)]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  const responses = parseMcpResponses(check.stdout);
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const response = responses.get(String(id));
    if (!response) {
      die(
        `Open Browser Use MCP browser smoke missing response id ${id}.\n${tail("stdout", check.stdout)}`,
      );
    }
    if (isObject(response.error)) {
      die(
        `Open Browser Use MCP browser smoke response ${id} failed: ${String(response.error.message ?? "unknown error")}`,
      );
    }
  }

  const pageValue = extractMcpPageValue(responses.get("7"));
  if (!isObject(pageValue)) {
    die(
      `Open Browser Use MCP browser smoke could not read page value.\n${tail("stdout", check.stdout)}`,
    );
  }
  const observedUrl = String(pageValue.url ?? "");
  const observedTitle = String(pageValue.title ?? "");
  const observedText = String(pageValue.text ?? "");
  const expectedHost = new URL(projectUrl).hostname;
  let observedHost = "";
  try {
    observedHost = new URL(observedUrl).hostname;
  } catch {
    observedHost = "";
  }
  if (observedHost !== expectedHost || !observedTitle || !observedText) {
    die(
      [
        "Open Browser Use MCP browser smoke did not observe the expected loaded page.",
        `expected-host: ${expectedHost}`,
        `observed-url: ${observedUrl}`,
        `observed-title: ${observedTitle}`,
      ].join("\n"),
    );
  }

  console.log("[browser-test] Open Browser Use MCP browser smoke: ok");
}

function mcpRequest(id: number, method: string, params: JsonObject): JsonObject {
  return { jsonrpc: "2.0", id, method, params };
}

function parseMcpResponses(stdout: string): Map<string, JsonObject> {
  const responses = new Map<string, JsonObject>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      die(`Open Browser Use MCP emitted non-JSON output: ${trimmed}`);
    }
    if (!isObject(parsed)) continue;
    const id = parsed.id;
    if (typeof id === "string" || typeof id === "number") {
      responses.set(String(id), parsed);
    }
  }
  return responses;
}

function extractMcpPageValue(response: JsonObject | undefined): unknown {
  const result = isObject(response?.result) ? response.result : null;
  const structuredContent = isObject(result?.structuredContent) ? result.structuredContent : null;
  const cliResult = isObject(structuredContent?.result) ? structuredContent.result : null;
  const cdpResult = isObject(cliResult?.result) ? cliResult.result : null;
  return cdpResult?.value;
}

function handleBrowserBackendUnavailable(result: CheckResult): void {
  if (!REQUIRE_LIVE_SMOKE) {
    console.log(
      "[browser-test] live Open Browser Use smoke skipped: browser extension/native host backend is not connected",
    );
    console.log(
      "[browser-test] run `open-browser-use setup`, install or enable the Chrome extension, then verify with `open-browser-use info`",
    );
    console.log(
      "[browser-test] set ORACLE_OPEN_BROWSER_USE_REQUIRE_LIVE=1 to fail unless the live Open Browser Use smoke completes",
    );
    console.log(`[browser-test] ${READY_TOKEN}`);
    return;
  }

  die(
    [
      "Open Browser Use browser backend is not reachable.",
      "Run `open-browser-use setup`, install or enable the Chrome extension, restart Chrome if requested, then verify with `open-browser-use info`.",
      commandFailure(result),
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );
}

function commandFailure(result: CheckResult): string | null {
  return [
    result.error ? `error: ${result.error.message}` : null,
    result.status === null ? null : `exit-status: ${result.status}`,
    tail("stdout", result.stdout),
    tail("stderr", result.stderr),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function normalizeUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.toString();
  } catch {
    die(`Invalid browser smoke URL: ${trimmed}`);
  }
}

function tail(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  return `${label}:\n${lines.slice(-40).join("\n")}`;
}

function die(message: string): never {
  console.error(`[browser-test] ${message}`);
  process.exit(1);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main();
