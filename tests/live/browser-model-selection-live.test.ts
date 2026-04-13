import { describe, expect, test } from "vitest";
import { runBrowserMode } from "../../src/browser/index.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";
import { hasChatGptSession, requireChatgptLiveProjectUrls } from "./chatgptLive.js";

const LIVE = process.env.ORACLE_LIVE_TEST === "1";

function createLogCapture() {
  const lines: string[] = [];
  const log: BrowserLogger = (message: string) => {
    lines.push(message);
  };
  return { log, lines };
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

const CASES = [
  {
    name: "auto",
    desiredModel: "GPT-5.2",
    expected: ["5.2"],
  },
  {
    name: "thinking",
    desiredModel: "GPT-5.2 Thinking",
    expected: ["5.2", "thinking"],
  },
  {
    name: "instant",
    desiredModel: "GPT-5.2 Instant",
    expected: ["5.2", "instant"],
  },
];

(LIVE ? describe : describe.skip)("ChatGPT browser live model selection", () => {
  test(
    "selects GPT-5.2 variants reliably",
    async () => {
      if (!(await hasChatGptSession("ChatGPT browser live model selection"))) return;
      const projectUrls = requireChatgptLiveProjectUrls();
      // Learned: serialize live browser tests to avoid Chrome profile contention.
      await acquireLiveTestLock("chatgpt-browser");
      try {
        for (const entry of CASES) {
          let completed = false;
          let lastError = "";
          for (const projectUrl of projectUrls) {
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              const { log, lines } = createLogCapture();
              try {
                const promptToken = `live browser ${entry.name}`;
                const result = await runBrowserMode({
                  prompt: `${promptToken}\nRepeat the first line exactly. No other text.`,
                  config: {
                    chromeProfile: "Default",
                    desiredModel: entry.desiredModel,
                    url: projectUrl,
                    timeoutMs: 180_000,
                  },
                  log,
                });

                const normalizedAnswer = result.answerText
                  .toLowerCase()
                  .replace(/\s+/g, " ")
                  .trim();
                const normalizedExpected = promptToken.toLowerCase();
                const truncatedOk =
                  normalizedExpected.startsWith(normalizedAnswer) &&
                  normalizedAnswer.length >= Math.max(0, normalizedExpected.length - 2);
                expect(normalizedAnswer.includes(normalizedExpected) || truncatedOk).toBe(true);

                const modelLog = lines.find((line) =>
                  line.toLowerCase().startsWith("model picker:"),
                );
                expect(modelLog).toBeTruthy();
                if (modelLog) {
                  const label = normalizeLabel(modelLog.replace(/^model picker:\s*/i, ""));
                  for (const token of entry.expected) {
                    expect(label).toContain(token);
                  }
                }
                completed = true;
                break;
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                lastError = message;
                if (message.includes("Unable to find model option")) {
                  console.warn(
                    `Skipping ${entry.name} model selection (not available for this account): ${message}`,
                  );
                  completed = true;
                  break;
                }
                if (message.includes("project URL missing")) {
                  console.warn(`Project URL unavailable (${projectUrl}); trying fallback.`);
                  break;
                }
                const transient =
                  message.includes("Chrome window closed before oracle finished") ||
                  message.includes("Prompt did not appear in conversation before timeout") ||
                  message.includes("Reattach target did not respond");
                if (transient && attempt < 3) {
                  console.warn(
                    `Retrying ${entry.name} model selection (attempt ${attempt + 1}/3): ${message}`,
                  );
                  await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
                  continue;
                }
                throw error;
              }
            }
            if (completed) {
              break;
            }
          }
          if (!completed) {
            throw new Error(
              `Live model selection did not complete for ${entry.name}: ${lastError || "unknown error"}`,
            );
          }
        }
      } finally {
        await releaseLiveTestLock("chatgpt-browser");
      }
    },
    15 * 60 * 1000,
  );
});
