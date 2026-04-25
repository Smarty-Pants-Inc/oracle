#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { THINKING_MENU_TRIGGER_SELECTORS } from "../src/browser/constants.js";
import {
  conversationHrefMatchesConfiguredScope,
  extractConversationIdFromUrl,
} from "../src/browser/reattachHelpers.js";
import { isProjectScopedChatgptUrl } from "../src/browser/utils.js";
import { attachSupervisorThread } from "../src/browser/supervisorThreads.js";
import type {
  SupervisorBrokerRequest,
  SupervisorBrokerResponse,
} from "../src/cli/supervisorBroker.js";
import { mapModelToBrowserLabel } from "../src/cli/browserConfig.js";
import {
  connectSupervisorRuntime,
  resolveSupervisorRuntimeContext,
} from "../src/cli/supervisorBrokerRuntime.js";
import type { ModelName, ThinkingTimeLevel } from "../src/oracle/types.js";
import { sessionStore } from "../src/sessionStore.js";
import { browserProofScript } from "./supervisor-proof.browser.js";

const LEVELS = new Set<ThinkingTimeLevel>(["light", "standard", "extended", "heavy"]);
const DEFAULT_MODEL: ModelName = "gpt-5.4";
const USAGE =
  "Usage: pnpm exec tsx scripts/supervisor-proof.ts [--thinking-time <level>] [--model <model>] [--prompt <text>]";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const BROKER_ENTRYPOINT = path.join(REPO_ROOT, "bin", "oracle-supervisor-broker.ts");
const BROKER_EXIT_TIMEOUT_MS = 15_000;
const BROKER_FORCE_KILL_TIMEOUT_MS = 5_000;
const BROWSER_PROOF_STATE_TIMEOUT_MS = 15_000;
const CHATGPT_URL = "https://chatgpt.com/";

function parseArgs(argv: string[]) {
  let thinkingTime: ThinkingTimeLevel = "extended";
  let model: ModelName = DEFAULT_MODEL;
  let prompt: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--thinking-time") {
      const value = argv[++i] as ThinkingTimeLevel | undefined;
      if (!value || !LEVELS.has(value)) {
        throw new Error("Expected --thinking-time light|standard|extended|heavy");
      }
      thinkingTime = value;
      continue;
    }
    if (arg === "--model") {
      const value = argv[++i]?.trim();
      if (!value) {
        throw new Error("Expected a value after --model");
      }
      model = value as ModelName;
      continue;
    }
    if (arg === "--prompt") {
      prompt = argv[++i];
      if (!prompt) {
        throw new Error("Expected a value after --prompt");
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { thinkingTime, model, prompt };
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
const isChecked = (item?: { ariaChecked: string | null; dataState: string | null }) =>
  item?.ariaChecked === "true" ||
  item?.dataState === "checked" ||
  item?.dataState === "selected" ||
  item?.dataState === "on";

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        timer = null;
        reject(errorFactory());
      }, timeoutMs);
      timer.unref?.();
      work.then(resolve, reject);
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForChildExit(
  child: Pick<ReturnType<typeof spawn>, "exitCode" | "signalCode" | "once" | "off" | "kill">,
  timeoutMs: number = BROKER_EXIT_TIMEOUT_MS,
  forceKillTimeoutMs: number = BROKER_FORCE_KILL_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
        cleanup();
        reject(new Error(`Supervisor broker did not exit within ${timeoutMs}ms after responding.`));
      }, forceKillTimeoutMs);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function assertBrokerExitedCleanly(exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): void {
  if (exit.signal) {
    throw new Error(
      `Supervisor broker exited with signal ${exit.signal} after responding. Refusing to trust partial proof output.`,
    );
  }
  if (exit.code !== 0) {
    throw new Error(
      `Supervisor broker exited with code ${exit.code ?? "null"} after responding. Refusing to trust partial proof output.`,
    );
  }
}

function normalizeComparableHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, CHATGPT_URL);
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function requireProjectScopedUrl(url: string | undefined, label: string): string {
  const candidate = url?.trim();
  if (!candidate || !isProjectScopedChatgptUrl(candidate, CHATGPT_URL)) {
    throw new Error(
      `${label} must be a ChatGPT project URL (/g/.../project). Refusing root/main or missing URL: ${candidate ?? "missing"}`,
    );
  }
  return candidate;
}

function assertProofOnExpectedThread({
  expectedConversationId,
  expectedTabUrl,
  observedHref,
}: {
  expectedConversationId?: string;
  expectedTabUrl?: string;
  observedHref: string;
}): void {
  const normalizedObservedHref = normalizeComparableHref(observedHref);
  if (!normalizedObservedHref) {
    throw new Error("Browser proof did not expose an active tab URL.");
  }
  const observedConversationId = extractConversationIdFromUrl(normalizedObservedHref);
  if (expectedConversationId) {
    if (observedConversationId !== expectedConversationId) {
      throw new Error(
        `Browser proof attached to conversation ${observedConversationId ?? "unknown"} instead of ${expectedConversationId}. Observed URL: ${observedHref}`,
      );
    }
    return;
  }
  if (!expectedTabUrl) {
    return;
  }
  const normalizedExpectedHref = normalizeComparableHref(expectedTabUrl);
  if (normalizedExpectedHref && normalizedObservedHref !== normalizedExpectedHref) {
    throw new Error(
      `Browser proof attached to unexpected tab ${observedHref}; expected ${expectedTabUrl}.`,
    );
  }
}

async function evaluateBrowserProofState(
  Runtime: {
    evaluate: (params: {
      expression: string;
      returnByValue: boolean;
      awaitPromise: boolean;
    }) => Promise<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>;
  },
  args: {
    chipSelectors: readonly string[];
    level: ThinkingTimeLevel;
    token: string;
  },
) {
  const response = await Runtime.evaluate({
    expression: `(${browserProofScript})(${JSON.stringify(args)})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Browser proof evaluation failed");
  }
  return response.result?.value as {
    href: string;
    title: string;
    proofPresent: boolean;
    menuFound: boolean;
    chipText: string;
    items: Array<{ text: string; ariaChecked: string | null; dataState: string | null }>;
    pngDataUrl: string;
  };
}

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
  const exit = await waitForChildExit(child);
  assertBrokerExitedCleanly(exit);
  return response;
}

async function main() {
  const { thinkingTime, model, prompt } = parseArgs(process.argv.slice(2));
  const proofToken = `PROOF_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const expectsInlineProofToken = !prompt;
  const response = await runSupervisorBrokerOverWire({
    action: "run_prompt",
    prompt: prompt ?? `Reply with exactly ${proofToken} and nothing else.`,
    sessionSlug: `proof-${thinkingTime}-${proofToken.toLowerCase()}`,
    model,
    browserModelStrategy: "select",
    browserModelLabel: mapModelToBrowserLabel(model),
    browserThinkingTime: thinkingTime,
    cwd: process.cwd(),
  });
  if (!response.ok) {
    throw new Error(response.error);
  }
  if (!("output" in response) || !("sessionId" in response)) {
    throw new Error("Unexpected supervisor broker response for run_prompt");
  }

  const { runtime } = await resolveSupervisorRuntimeContext(response.sessionId);
  if (!runtime?.tabUrl || !runtime?.conversationId) {
    throw new Error("Supervisor proof session is missing browser runtime metadata");
  }
  const expectedConversationId = extractConversationIdFromUrl(runtime.tabUrl);
  if (!expectedConversationId || expectedConversationId !== runtime.conversationId) {
    throw new Error(
      `Supervisor proof session runtime metadata is missing stable thread identity. tabUrl=${runtime.tabUrl} conversationId=${runtime.conversationId ?? "unknown"}`,
    );
  }

  const { dir } = await sessionStore.getPaths(response.sessionId);
  const screenshotPath = path.join(dir, `supervisor-proof-${thinkingTime}.png`);
  const sessionMeta = await sessionStore.readSession(response.sessionId);
  const configuredProjectUrl = requireProjectScopedUrl(
    sessionMeta?.supervisorThread?.projectUrl ??
      sessionMeta?.browser?.config?.supervisorChatgptUrl ??
      sessionMeta?.browser?.config?.chatgptUrl ??
      sessionMeta?.browser?.config?.url ??
      undefined,
    "Supervisor proof scope",
  );
  if (!conversationHrefMatchesConfiguredScope(runtime.tabUrl, configuredProjectUrl)) {
    throw new Error(
      `Supervisor proof runtime URL is outside the configured project scope. runtime.tabUrl=${runtime.tabUrl} configuredProjectUrl=${configuredProjectUrl}`,
    );
  }
  const connection = await connectSupervisorRuntime(runtime, {
    dedicatedHiddenTargetUrl: runtime.tabUrl,
  });

  try {
    if (runtime.conversationId) {
      await attachSupervisorThread(connection.client.Runtime, runtime.conversationId, {
        projectUrl: configuredProjectUrl,
        threadUrl: runtime.tabUrl ?? undefined,
      });
    }
    let state:
      | {
          href: string;
          title: string;
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
        const candidate = await withTimeout(
          evaluateBrowserProofState(connection.client.Runtime, {
            chipSelectors: THINKING_MENU_TRIGGER_SELECTORS,
            level: thinkingTime,
            token: proofToken,
          }),
          BROWSER_PROOF_STATE_TIMEOUT_MS,
          () => new Error("Timed out waiting for browser proof state"),
        );
        assertProofOnExpectedThread({
          expectedConversationId: runtime.conversationId,
          expectedTabUrl: runtime.tabUrl,
          observedHref: candidate.href,
        });
        const selectedItem = candidate.items.find(
          (item) => item.text.toLowerCase() === titleCase(thinkingTime).toLowerCase(),
        );
        const responseObserved = expectsInlineProofToken
          ? candidate.proofPresent
          : response.output.trim().length > 0;
        if (responseObserved && candidate.menuFound && isChecked(selectedItem)) {
          state = candidate;
          break;
        }
        lastError = new Error(
          `Proof not ready yet: ${JSON.stringify({ responseObserved, proofPresent: candidate.proofPresent, menuFound: candidate.menuFound, selectedItem, chipText: candidate.chipText, href: candidate.href })}`,
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
    await connection.close();
  }
}

export const __test__ = {
  assertBrokerExitedCleanly,
  assertProofOnExpectedThread,
  evaluateBrowserProofState,
  normalizeComparableHref,
  requireProjectScopedUrl,
  withTimeout,
  waitForChildExit,
};

const isMainModule =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
