#!/usr/bin/env tsx
/**
 * Open Browser Use MCP smoke for Oracle browser harnesses.
 *
 * This intentionally does not call Oracle's legacy browser engine. The harness
 * proves the installed Open Browser Use CLI/MCP path, opens a live ChatGPT tab
 * through `obu mcp`, reads page state through MCP CDP, and finalizes the tab.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const OK_TOKEN = "ORACLE_OPEN_BROWSER_USE_SMOKE_OK";
const READY_TOKEN = "ORACLE_OPEN_BROWSER_USE_READY_OK";
const REQUIRE_LIVE_SMOKE = process.env.ORACLE_OPEN_BROWSER_USE_REQUIRE_LIVE === "1";
const REQUIRE_UPLOAD_SMOKE = process.env.ORACLE_OPEN_BROWSER_USE_UPLOAD_SMOKE === "1";
const SKIP_CHATGPT_SMOKE = process.env.ORACLE_OPEN_BROWSER_USE_SKIP_CHATGPT_SMOKE === "1";

type CheckResult = {
  name: string;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type JsonObject = Record<string, unknown>;

async function main(): Promise<void> {
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

  if (!SKIP_CHATGPT_SMOKE) {
    runMcpBrowserSmoke(projectUrl);
  }
  if (REQUIRE_UPLOAD_SMOKE) {
    await runUploadSmoke();
  }
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

function runObuAsync(args: string[], timeout: number): Promise<CheckResult> {
  const command = process.env.OBU_BIN?.trim() || "obu";
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ name: `${command} ${args.join(" ")}`, status: null, stdout, stderr, error });
    });
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve({ name: `${command} ${args.join(" ")}`, status, stdout, stderr });
    });
  });
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

async function runUploadSmoke(): Promise<void> {
  const sessionID = `oracle-open-browser-use-upload-${Date.now()}`;
  const tempDir = mkdtempSync(join(tmpdir(), "oracle-obu-upload-"));
  const uploadPath = join(tempDir, "oracle-upload-smoke.txt");
  writeFileSync(uploadPath, "oracle open browser use upload smoke\n", "utf8");

  let server: Server | null = null;
  let waitProcess: ReturnType<typeof spawn> | null = null;
  try {
    server = createServer((_request, response) => {
      response.writeHead(200, {
        "cache-control": "no-store",
        connection: "close",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(uploadSmokePage());
    });
    const port = await listen(server);
    const opened = await runObuJSON(
      [
        "open-tab",
        "--session-id",
        sessionID,
        "--timeout",
        "10s",
        "--url",
        `http://127.0.0.1:${port}/`,
      ],
      20_000,
      "Open Browser Use upload smoke could not open local test page.",
    );
    const tabID = tabIDFromOpenTab(opened);
    const point = await waitForUploadButtonPoint(sessionID, tabID);
    await runCDP(sessionID, tabID, "Page.bringToFront", {});

    waitProcess = spawn(process.env.OBU_BIN?.trim() || "obu", [
      "wait-file-chooser",
      "--session-id",
      sessionID,
      "--tab-id",
      String(tabID),
      "--timeout",
      "10s",
    ]);
    const chooserPromise = collectObuProcessJSON(waitProcess);
    await delay(750);
    await runCDP(sessionID, tabID, "Input.dispatchMouseEvent", {
      button: "none",
      buttons: 0,
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await runCDP(sessionID, tabID, "Input.dispatchMouseEvent", {
      button: "left",
      buttons: 1,
      clickCount: 1,
      type: "mousePressed",
      x: point.x,
      y: point.y,
    });
    await runCDP(sessionID, tabID, "Input.dispatchMouseEvent", {
      button: "left",
      buttons: 0,
      clickCount: 1,
      type: "mouseReleased",
      x: point.x,
      y: point.y,
    });

    const chooser = await chooserPromise;
    const chooserID = fileChooserID(chooser);
    if (!chooserID) {
      die(
        `Open Browser Use upload smoke did not receive a file chooser id.\n${JSON.stringify(chooser)}`,
      );
    }

    const setFiles = await runObuJSON(
      [
        "set-file-chooser-files",
        "--session-id",
        sessionID,
        "--timeout",
        "10s",
        "--file-chooser-id",
        chooserID,
        "--file",
        uploadPath,
      ],
      15_000,
      "Open Browser Use upload smoke could not set chooser files.",
    );
    if (isObject(setFiles.error)) {
      die(
        `Open Browser Use upload smoke set-file-chooser-files failed: ${String(setFiles.error.message ?? "unknown error")}`,
      );
    }

    const selected = await waitForSelectedUploadName(sessionID, tabID);
    if (selected !== "oracle-upload-smoke.txt") {
      die(`Open Browser Use upload smoke selected wrong file: ${selected}`);
    }
    console.log("[browser-test] Open Browser Use upload smoke: ok");
  } finally {
    if (waitProcess && waitProcess.exitCode === null) {
      waitProcess.kill("SIGTERM");
    }
    await runObuAsync(
      ["finalize-tabs", "--session-id", sessionID, "--timeout", "10s", "--keep", "[]"],
      15_000,
    );
    await closeServer(server);
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function uploadSmokePage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Oracle Open Browser Use Upload Smoke</title>
<body>
  <button id="choose" style="font-size:20px;margin:40px">Choose</button>
  <input id="file" type="file" multiple style="display:none">
  <div id="selected">empty</div>
  <script>
    choose.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      selected.textContent = Array.from(file.files).map((entry) => entry.name).join(',') || 'empty';
    });
  </script>
</body>`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
        return;
      }
      reject(new Error("local upload smoke server did not bind to a TCP port"));
    });
  });
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 500);
    fallback.unref?.();
    server.close(() => {
      clearTimeout(fallback);
      resolve();
    });
  });
}

function collectObuProcessJSON(child: ReturnType<typeof spawn>): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (status) => {
      if (status !== 0) {
        reject(new Error(stderr.trim() || `obu wait-file-chooser exited ${status}`));
        return;
      }
      const parsed = parseJSONOutput(
        stdout,
        "Open Browser Use wait-file-chooser emitted invalid JSON.",
      );
      resolve(parsed);
    });
  });
}

async function waitForUploadButtonPoint(
  sessionID: string,
  tabID: number,
): Promise<{ x: number; y: number }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await runRuntimeEvaluate(
      sessionID,
      tabID,
      `(() => { const el = document.getElementById('choose'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    const point = extractRuntimeValue(response);
    if (isObject(point) && typeof point.x === "number" && typeof point.y === "number") {
      return { x: point.x, y: point.y };
    }
    await delay(100);
  }
  die("Open Browser Use upload smoke local page did not render the upload button.");
}

async function waitForSelectedUploadName(sessionID: string, tabID: number): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await runRuntimeEvaluate(
      sessionID,
      tabID,
      `Array.from(document.getElementById('file').files).map((entry) => entry.name).join(',')`,
    );
    const selected = extractRuntimeValue(response);
    if (typeof selected === "string" && selected) return selected;
    await delay(100);
  }
  return "";
}

async function runRuntimeEvaluate(
  sessionID: string,
  tabID: number,
  expression: string,
): Promise<JsonObject> {
  return runCDP(sessionID, tabID, "Runtime.evaluate", { expression, returnByValue: true });
}

async function runCDP(
  sessionID: string,
  tabID: number,
  method: string,
  params: JsonObject,
): Promise<JsonObject> {
  return runObuJSON(
    [
      "cdp",
      "--session-id",
      sessionID,
      "--tab-id",
      String(tabID),
      "--timeout",
      "10s",
      "--method",
      method,
      "--params",
      JSON.stringify(params),
    ],
    15_000,
    `Open Browser Use upload smoke CDP command failed: ${method}`,
  );
}

async function runObuJSON(args: string[], timeout: number, message: string): Promise<JsonObject> {
  const result = await runObuAsync(args, timeout);
  if (result.status !== 0) {
    die(
      [message, commandFailure(result)].filter((line): line is string => Boolean(line)).join("\n"),
    );
  }
  return parseJSONOutput(result.stdout, message);
}

function parseJSONOutput(stdout: string, message: string): JsonObject {
  const trimmed = stdout.trim();
  if (!trimmed) die(`${message}\nstdout was empty`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    die(`${message}\n${tail("stdout", stdout)}`);
  }
  if (!isObject(parsed)) die(`${message}\nJSON output was not an object`);
  return parsed;
}

function tabIDFromOpenTab(response: JsonObject): number {
  const tab = isObject(response.tab) ? response.tab : null;
  const id = tab?.id;
  if (typeof id === "number" && Number.isInteger(id) && id > 0) {
    return id;
  }
  die(
    `Open Browser Use upload smoke open-tab response did not include a tab id.\n${JSON.stringify(response)}`,
  );
}

function fileChooserID(response: JsonObject): string | null {
  const result = isObject(response.result) ? response.result : null;
  const id = result?.fileChooserId ?? result?.file_chooser_id;
  return typeof id === "string" && id ? id : null;
}

function extractRuntimeValue(response: JsonObject): unknown {
  const result = isObject(response.result) ? response.result : null;
  const cdpResult = isObject(result?.result) ? result.result : null;
  return cdpResult?.value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

main().catch((error: unknown) => {
  die(error instanceof Error ? error.message : String(error));
});
