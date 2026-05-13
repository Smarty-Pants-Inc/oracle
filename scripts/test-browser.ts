#!/usr/bin/env tsx
/**
 * Official Codex Chrome-plugin smoke for Oracle browser harnesses.
 *
 * This intentionally does not launch Chrome, read cookies, open a DevTools
 * port, or call Oracle's legacy browser engine. The harness now proves the
 * installed Codex Chrome Extension path first, then delegates the live ChatGPT
 * browser smoke to a nested Codex task that must use @chrome.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const OK_TOKEN = "ORACLE_CHROME_PLUGIN_SMOKE_OK";
const READY_TOKEN = "ORACLE_CHROME_PLUGIN_READY_OK";
const FAIL_PREFIX = "ORACLE_CHROME_PLUGIN_SMOKE_FAIL:";
const REQUIRE_LIVE_SMOKE = process.env.ORACLE_CODEX_CHROME_REQUIRE_LIVE === "1";

type CheckResult = {
  name: string;
  status: number | null;
  stdout: string;
  stderr: string;
};

type CodexResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  lastMessage: string;
};

function main(): void {
  const pluginRoot = resolveChromePluginRoot();
  const browserClient = path.join(pluginRoot, "scripts", "browser-client.mjs");
  if (!existsSync(browserClient)) {
    die(`Codex Chrome plugin is missing scripts/browser-client.mjs at ${pluginRoot}`);
  }

  console.log(`[browser-test] Codex Chrome plugin: ${pluginRoot}`);
  runPluginReadinessCheck(pluginRoot, "chrome-is-running.js", ["--json"]);
  runPluginReadinessCheck(pluginRoot, "check-extension-installed.js", ["--json"]);
  runPluginReadinessCheck(pluginRoot, "check-native-host-manifest.js", ["--json"]);

  const projectUrl =
    normalizeUrl(process.env.ORACLE_CHATGPT_PROJECT_URL) ??
    normalizeUrl(process.env.ORACLE_SUPERVISOR_CHATGPT_URL) ??
    normalizeUrl(process.env.ORACLE_BROWSER_SMOKE_CHATGPT_URL) ??
    "https://chatgpt.com/";

  const result = runCodexChromeSmoke(projectUrl);
  const lastMessage = result.lastMessage.trim();
  if (result.status === 0 && lastMessage === OK_TOKEN) {
    console.log(`[browser-test] ${OK_TOKEN}`);
    return;
  }

  if (!REQUIRE_LIVE_SMOKE && isCodexChromeRuntimeUnavailable(lastMessage)) {
    console.log(
      "[browser-test] live @chrome smoke skipped: this codex exec context does not expose the official Chrome plugin tools",
    );
    console.log(
      "[browser-test] set ORACLE_CODEX_CHROME_REQUIRE_LIVE=1 to fail unless the live @chrome smoke completes",
    );
    console.log(`[browser-test] ${READY_TOKEN}`);
    return;
  }

  {
    const detail = lastMessage.startsWith(FAIL_PREFIX)
      ? lastMessage
      : [
          `${FAIL_PREFIX} official Chrome plugin was not usable from codex exec`,
          lastMessage ? `last-message=${JSON.stringify(lastMessage)}` : null,
          tail("stdout", result.stdout),
          tail("stderr", result.stderr),
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n");
    die(detail);
  }
}

function resolveChromePluginRoot(): string {
  const configured = process.env.CODEX_CHROME_PLUGIN_ROOT?.trim();
  if (configured) return configured;

  const cacheRoot = path.join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "chrome");
  if (!existsSync(cacheRoot)) {
    die(`Codex Chrome plugin cache not found at ${cacheRoot}`);
  }

  const candidates = readdirSync(cacheRoot)
    .map((name) => path.join(cacheRoot, name))
    .filter((candidate) => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((candidate) => existsSync(path.join(candidate, "scripts", "browser-client.mjs")))
    .sort((left, right) => compareVersionPaths(right, left));

  const selected = candidates[0];
  if (!selected) {
    die(
      `No installed Codex Chrome plugin version with scripts/browser-client.mjs under ${cacheRoot}`,
    );
  }
  return selected;
}

function compareVersionPaths(leftPath: string, rightPath: string): number {
  const left = path
    .basename(leftPath)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const right = path
    .basename(rightPath)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return leftPath.localeCompare(rightPath);
}

function runPluginReadinessCheck(pluginRoot: string, scriptName: string, args: string[]): void {
  const scriptPath = path.join(pluginRoot, "scripts", scriptName);
  const result = runNode(scriptPath, args, pluginRoot);
  if (result.status !== 0) {
    die(
      [
        `Codex Chrome plugin readiness check failed: ${scriptName}`,
        tail("stdout", result.stdout),
        tail("stderr", result.stderr),
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }
  console.log(`[browser-test] ${scriptName}: ok`);
}

function runNode(scriptPath: string, args: string[], cwd: string): CheckResult {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    name: path.basename(scriptPath),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runCodexChromeSmoke(projectUrl: string): CodexResult {
  const codexBin = process.env.CODEX_BIN?.trim() || "codex";
  const cwd = path.resolve(path.join(import.meta.dirname, ".."));
  const tempRoot = mkdtempSync(path.join(tmpdir(), "oracle-chrome-plugin-smoke-"));
  const lastMessagePath = path.join(tempRoot, "last-message.txt");
  const attachmentPath = path.join(tempRoot, "smoke-attachment.txt");
  writeFileSync(attachmentPath, "smoke-attachment\n", "utf8");

  const prompt = [
    "Use @chrome only. Do not use shell, AppleScript, raw Chrome DevTools, Playwright outside the official Chrome plugin, Computer Use, or Oracle's legacy browser engine.",
    "This is the Oracle browser harness smoke.",
    `Target URL: ${projectUrl}`,
    `Attachment path: ${attachmentPath}`,
    `If this Codex runtime does not expose a callable official Chrome plugin browser tool, reply exactly ${FAIL_PREFIX} official Chrome plugin tools unavailable.`,
    "Open or claim a Chrome tab for the target URL using the official Codex Chrome plugin.",
    "Upload the attachment through the official Chrome plugin file chooser flow.",
    "Send this exact ChatGPT prompt: Read the attached file and return exactly one markdown bullet '- upload: smoke-attachment' and nothing else.",
    "Wait for the assistant response.",
    `If the response contains '- upload: smoke-attachment', finalize Chrome tabs and reply exactly ${OK_TOKEN}.`,
    `If the official Chrome plugin is unavailable or the response is not observed, finalize any Chrome tabs you created if possible and reply exactly ${FAIL_PREFIX} <short reason>.`,
  ].join("\n");

  const result: SpawnSyncReturns<string> = spawnSync(
    codexBin,
    ["exec", "--ephemeral", "-C", cwd, "-o", lastMessagePath, prompt],
    {
      cwd,
      encoding: "utf8",
      input: "",
      timeout: Number.parseInt(process.env.ORACLE_CODEX_CHROME_TIMEOUT_MS ?? "900000", 10),
    },
  );

  let lastMessage = "";
  try {
    lastMessage = readFileSync(lastMessagePath, "utf8");
  } catch {
    lastMessage = "";
  }
  rmSync(tempRoot, { force: true, recursive: true });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    lastMessage,
  };
}

function isCodexChromeRuntimeUnavailable(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.startsWith(FAIL_PREFIX.toLowerCase()) &&
    normalized.includes("official chrome plugin") &&
    (normalized.includes("tool") ||
      normalized.includes("runtime") ||
      normalized.includes("node_repl") ||
      normalized.includes("browser-client")) &&
    (normalized.includes("unavailable") ||
      normalized.includes("not available") ||
      normalized.includes("not usable") ||
      normalized.includes("missing"))
  );
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

main();
