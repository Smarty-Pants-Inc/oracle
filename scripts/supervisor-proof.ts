#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import type {
  SupervisorBrokerRequest,
  SupervisorBrokerResponse,
} from "../src/cli/supervisorBroker.js";
import { sessionStore } from "../src/sessionStore.js";
import type { ThinkingTimeLevel } from "../src/oracle/types.js";
import { browserProofScript } from "./supervisor-proof.browser.js";

const LEVELS = new Set<ThinkingTimeLevel>(["light", "standard", "extended", "heavy"]);
const CHIP_SELECTORS = [
  '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
  'button.__composer-pill[aria-haspopup="menu"]',
  '.__composer-pill-composite button[aria-haspopup="menu"]',
];
const USAGE =
  "Usage: pnpm exec tsx scripts/supervisor-proof.ts [--thinking-time <level>] [--prompt <text>]";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const BROKER_ENTRYPOINT = path.join(REPO_ROOT, "bin", "oracle-supervisor-broker.ts");

function parseArgs(argv: string[]) {
  let thinkingTime: ThinkingTimeLevel = "extended";
  let prompt: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--thinking-time") {
      const value = argv[++i] as ThinkingTimeLevel | undefined;
      if (!value || !LEVELS.has(value))
        throw new Error("Expected --thinking-time light|standard|extended|heavy");
      thinkingTime = value;
      continue;
    }
    if (arg === "--prompt") {
      prompt = argv[++i];
      if (!prompt) throw new Error("Expected a value after --prompt");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { thinkingTime, prompt };
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
const isChecked = (item?: { ariaChecked: string | null; dataState: string | null }) =>
  item?.ariaChecked === "true" ||
  item?.dataState === "checked" ||
  item?.dataState === "selected" ||
  item?.dataState === "on";

async function runSupervisorBrokerOverWire(
  request: SupervisorBrokerRequest,
): Promise<SupervisorBrokerResponse> {
  const child = spawn(process.execPath, [TSX_CLI, BROKER_ENTRYPOINT], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const responsePromise = new Promise<SupervisorBrokerResponse>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      rl.close();
      callback();
    };
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      finish(() => {
        try {
          resolve(JSON.parse(trimmed) as SupervisorBrokerResponse);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(`Supervisor broker returned invalid JSON: ${message}`));
        }
      });
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", (code, signal) => {
      finish(() =>
        reject(
          new Error(
            `Supervisor broker exited before responding (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr.trim() || "no stderr"}`,
          ),
        ),
      );
    });
  });

  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end(`${JSON.stringify({ shutdown: true })}\n`);
  const response = await responsePromise;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
  }
  return response;
}

async function main() {
  const { thinkingTime, prompt } = parseArgs(process.argv.slice(2));
  const proofToken = `PROOF_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const response = await runSupervisorBrokerOverWire({
    action: "run_prompt",
    prompt: prompt ?? `Reply with exactly ${proofToken} and nothing else.`,
    sessionSlug: `proof-${thinkingTime}-${proofToken.toLowerCase()}`,
    model: "gpt-5.4-pro",
    browserModelStrategy: "select",
    browserModelLabel: "GPT-5.4 Pro",
    browserThinkingTime: thinkingTime,
    cwd: process.cwd(),
  });
  if (!response.ok) throw new Error(response.error);
  if (!("output" in response) || !("sessionId" in response)) {
    throw new Error("Unexpected supervisor broker response for run_prompt");
  }

  const runtime = (await sessionStore.readSession(response.sessionId))?.browser?.runtime;
  if (!runtime?.tabUrl || !runtime.chromePort)
    throw new Error("Supervisor proof session is missing browser runtime metadata");

  const { dir } = await sessionStore.getPaths(response.sessionId);
  const screenshotPath = path.join(dir, `supervisor-proof-${thinkingTime}.png`);
  const browser = await puppeteer.connect({
    browserURL: `http://${runtime.chromeHost ?? "127.0.0.1"}:${runtime.chromePort}`,
    defaultViewport: null,
    protocolTimeout: 120_000,
  });

  try {
    const page = (await browser.pages()).at(-1);
    if (!page) throw new Error("No active hidden Oracle browser page found");
    await page.setViewport({ width: 1600, height: 1400, deviceScaleFactor: 1 });
    await page.goto(runtime.tabUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("body", { timeout: 60_000 });

    let state:
      | {
          proofPresent: boolean;
          menuFound: boolean;
          chipText: string;
          items: Array<{ text: string; ariaChecked: string | null; dataState: string | null }>;
          pngDataUrl: string;
        }
      | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const candidate = (await Promise.race([
          page.evaluate(
            ({ source, args }) => {
              const fn = new Function(`return (${source});`)() as (
                input: typeof args,
              ) => Promise<unknown>;
              return fn(args);
            },
            {
              source: browserProofScript,
              args: { chipSelectors: CHIP_SELECTORS, level: thinkingTime, token: proofToken },
            },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Timed out waiting for browser proof state")),
              15_000,
            ),
          ),
        ])) as {
          proofPresent: boolean;
          menuFound: boolean;
          chipText: string;
          items: Array<{ text: string; ariaChecked: string | null; dataState: string | null }>;
          pngDataUrl: string;
        };
        const selectedItem = candidate.items.find(
          (item) => item.text.toLowerCase() === titleCase(thinkingTime).toLowerCase(),
        );
        if (candidate.proofPresent && candidate.menuFound && isChecked(selectedItem)) {
          state = candidate;
          break;
        }
        lastError = new Error(
          `Proof not ready yet: ${JSON.stringify({ proofPresent: candidate.proofPresent, menuFound: candidate.menuFound, selectedItem, chipText: candidate.chipText })}`,
        );
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    if (!state) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    await fs.writeFile(
      screenshotPath,
      Buffer.from(state.pngDataUrl.replace("data:image/png;base64,", ""), "base64"),
    );
    const { pngDataUrl: _pngDataUrl, ...reportState } = state;
    console.log(
      JSON.stringify(
        {
          sessionId: response.sessionId,
          output: response.output.trim(),
          screenshotPath,
          threadUrl: runtime.tabUrl,
          state: reportState,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
