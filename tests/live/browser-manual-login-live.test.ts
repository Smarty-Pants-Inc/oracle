import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import CDP from "chrome-remote-interface";
import { runBrowserMode } from "../../src/browser/index.js";
import {
  getDevToolsActivePortPaths,
  readDevToolsPort,
  verifyDevToolsReachable,
} from "../../src/browser/profileState.js";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";
import { hasChatGptSession, requireChatgptLiveProjectUrls } from "./chatgptLive.js";

const LIVE = process.env.ORACLE_LIVE_TEST === "1";
const MANUAL = process.env.ORACLE_LIVE_TEST_MANUAL_LOGIN === "1";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevToolsPort(
  userDataDir: string,
  timeoutMs = 30_000,
  shouldAbort?: () => Error | null,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const abortError = shouldAbort?.();
    if (abortError) {
      throw abortError;
    }
    const port = await readDevToolsPort(userDataDir);
    if (port) return port;
    await delay(250);
  }
  throw new Error("Timed out waiting for DevToolsActivePort.");
}

async function waitForPageTarget(host: string, port: number, timeoutMs = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await CDP.List({ host, port });
      const candidate =
        targets.find((target) => target.type === "page" && target.url?.includes("chatgpt.com")) ??
        targets.find((target) => target.type === "page" && !target.url?.startsWith("chrome://")) ??
        targets.find((target) => target.type === "page");
      if (candidate?.id) {
        return candidate.id;
      }
    } catch {
      // ignore and retry
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for an inspectable page target.");
}

(LIVE && MANUAL ? describe : describe.skip)("ChatGPT browser live manual-login cleanup", () => {
  test(
    "preserves DevToolsActivePort when connection drops but Chrome stays running",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-manual-login-"));
      if (!(await hasChatGptSession("manual-login live test"))) {
        return;
      }
      const [projectUrl] = requireChatgptLiveProjectUrls();

      await acquireLiveTestLock("chatgpt-browser");
      try {
        let runError: Error | null = null;
        const promptToken = `live manual login cleanup ${Date.now()}`;
        const runPromise = runBrowserMode({
          prompt: `${promptToken}\nRepeat the first line exactly. No other text.`,
          config: {
            manualLogin: true,
            manualLoginProfileDir: profileDir,
            manualLoginCookieSync: true,
            chromeProfile: "Default",
            keepBrowser: false,
            url: projectUrl,
            timeoutMs: 180_000,
          },
        })
          .then((result) => ({ status: "resolved" as const, result }))
          .catch((error) => {
            runError = error instanceof Error ? error : new Error(String(error));
            return { status: "rejected" as const, error: runError };
          });
        const port = await waitForDevToolsPort(profileDir, 60_000, () => runError);

        const host = "127.0.0.1";
        const targetId = await waitForPageTarget(host, port, 60_000);

        await delay(1_000);
        await CDP.Close({ host, port, id: targetId });

        const outcome = await runPromise;
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          expect(outcome.error.message.toLowerCase()).toMatch(
            /connection|chrome window closed|target closed/,
          );
        }

        const probe = await verifyDevToolsReachable({ port, host });
        if (!probe.ok) {
          console.warn(
            "Skipping DevToolsActivePort assertion; Chrome not reachable after target close.",
          );
          return;
        }

        const userDataDir = profileDir;
        const paths = getDevToolsActivePortPaths(userDataDir);
        expect(paths.some((candidate) => existsSync(candidate))).toBe(true);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
        await releaseLiveTestLock("chatgpt-browser");
      }
    },
    12 * 60 * 1000,
  );
});
