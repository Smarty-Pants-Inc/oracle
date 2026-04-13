import { describe, test, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { runBrowserMode } from "../../src/browser/index.js";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";
import { hasChatGptSession, requireChatgptLiveProjectUrls } from "./chatgptLive.js";

const LIVE = process.env.ORACLE_LIVE_TEST === "1";
const FAST = process.env.ORACLE_LIVE_TEST_FAST === "1";

(LIVE && FAST ? describe : describe.skip)("ChatGPT browser fast live", () => {
  test(
    "opens a configured project URL before sending",
    async () => {
      if (!(await hasChatGptSession("fast live test"))) {
        return;
      }
      const projectUrls = requireChatgptLiveProjectUrls();
      await acquireLiveTestLock("chatgpt-browser");
      try {
        let result: Awaited<ReturnType<typeof runBrowserMode>> | null = null;
        let lastError = "";
        for (const projectUrl of projectUrls) {
          try {
            result = await runBrowserMode({
              prompt: `fast project smoke ${Date.now()}\nReply with OK only.`,
              config: {
                url: projectUrl,
                timeoutMs: 180_000,
                inputTimeoutMs: 20_000,
              },
            });
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lastError = message;
            if (message.includes("project URL missing")) {
              console.warn(`Project URL unavailable (${projectUrl}); trying fallback.`);
              continue;
            }
            throw error;
          }
        }
        if (!result) {
          throw new Error(`Live project smoke did not complete: ${lastError || "unknown error"}`);
        }
        expect(result.answerText.toLowerCase()).toContain("ok");
      } finally {
        await releaseLiveTestLock("chatgpt-browser");
      }
    },
    6 * 60 * 1000,
  );

  test(
    "uploads attachments and sends the prompt (gpt-5.2)",
    async () => {
      if (!(await hasChatGptSession("fast live attachment test"))) {
        return;
      }
      const projectUrls = requireChatgptLiveProjectUrls();
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-fast-live-"));
      await acquireLiveTestLock("chatgpt-browser");
      try {
        const fileA = path.join(tmpDir, "oracle-fast-a.txt");
        const fileB = path.join(tmpDir, "oracle-fast-b.txt");
        await writeFile(fileA, `fast file a ${Date.now()}`);
        await writeFile(fileB, `fast file b ${Date.now()}`);
        const [statA, statB] = await Promise.all([stat(fileA), stat(fileB)]);
        const promptToken = `fast upload ${Date.now()}`;
        let result: Awaited<ReturnType<typeof runBrowserMode>> | null = null;
        let lastError = "";
        for (const projectUrl of projectUrls) {
          try {
            result = await runBrowserMode({
              prompt: `${promptToken}\nReply with OK only.`,
              attachments: [
                { path: fileA, displayPath: "oracle-fast-a.txt", sizeBytes: statA.size },
                { path: fileB, displayPath: "oracle-fast-b.txt", sizeBytes: statB.size },
              ],
              config: {
                url: projectUrl,
                timeoutMs: 240_000,
                inputTimeoutMs: 60_000,
              },
            });
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lastError = message;
            if (message.includes("project URL missing")) {
              console.warn(`Project URL unavailable (${projectUrl}); trying fallback.`);
              continue;
            }
            throw error;
          }
        }
        if (!result) {
          throw new Error(
            `Live attachment upload did not complete: ${lastError || "unknown error"}`,
          );
        }
        expect(result.answerText.toLowerCase()).toContain("ok");
      } finally {
        await releaseLiveTestLock("chatgpt-browser");
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    8 * 60 * 1000,
  );
});
