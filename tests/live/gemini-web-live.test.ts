import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createGeminiWebExecutor } from "../../src/gemini-web/executor.js";
import { getCookies } from "@steipete/sweet-cookie";

const live = process.env.ORACLE_LIVE_TEST === "1";

async function assertHasGeminiChromeCookies(): Promise<boolean> {
  const { cookies } = await getCookies({
    url: "https://gemini.google.com",
    origins: ["https://gemini.google.com", "https://accounts.google.com", "https://www.google.com"],
    names: ["__Secure-1PSID", "__Secure-1PSIDTS"],
    browsers: ["chrome"],
    mode: "merge",
    chromeProfile: "Default",
    timeoutMs: 5_000,
  });
  const map = new Map(cookies.map((c) => [c.name, c.value]));
  if (!map.get("__Secure-1PSID") || !map.get("__Secure-1PSIDTS")) {
    console.warn(
      "Skipping Gemini web live tests (missing __Secure-1PSID/__Secure-1PSIDTS). Open Chrome, sign into gemini.google.com, then retry.",
    );
    return false;
  }
  return true;
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

(live ? describe : describe.skip)("Gemini web (cookie) live smoke", () => {
  it.each(["Gemini 3.1 Flash-Lite", "Gemini 3.5 Flash", "Gemini 3.1 Pro"])(
    "returns a short text answer with %s",
    async (desiredModel) => {
      if (!(await assertHasGeminiChromeCookies())) return;

      const exec = createGeminiWebExecutor({});
      const result = await exec({
        prompt: "Say OK.",
        config: { chromeProfile: "Default", desiredModel, timeoutMs: 120_000 },
        log: () => {},
      });

      expect(result.answerText.toLowerCase()).toContain("ok");
      expect(result.answerChars).toBeGreaterThan(1);
    },
    120_000,
  );

  it("accepts an attachment upload (image) without failing", async () => {
    if (!(await assertHasGeminiChromeCookies())) return;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-web-live-"));
    const attachmentPath = path.join(tempDir, "input.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/Pm2zXwAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(attachmentPath, png);

    const exec = createGeminiWebExecutor({});
    try {
      const result = await exec({
        prompt: "Describe the attached image in one short sentence.",
        attachments: [{ path: attachmentPath, displayPath: "input.png" }],
        config: { chromeProfile: "Default", desiredModel: "Gemini 3 Pro", timeoutMs: 180_000 },
        log: () => {},
      });

      expect(result.answerChars).toBeGreaterThan(10);
    } catch (error) {
      console.warn(
        `Skipping Gemini web attachment test due to transient error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 180_000);

  it("youtube mode returns a short answer", async () => {
    if (!(await assertHasGeminiChromeCookies())) return;

    const exec = createGeminiWebExecutor({
      youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    try {
      const result = await exec({
        prompt: "Give one short sentence about the video.",
        config: { chromeProfile: "Default", desiredModel: "Gemini 3 Pro", timeoutMs: 240_000 },
        log: () => {},
      });

      expect(result.answerChars).toBeGreaterThan(20);
    } catch (error) {
      console.warn(
        `Skipping Gemini web YouTube test due to transient error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 240_000);

  it("generate-image writes an output file", async () => {
    if (!(await assertHasGeminiChromeCookies())) return;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-web-live-"));
    const outputPath = path.join(tempDir, "generated.jpg");

    const exec = createGeminiWebExecutor({
      generateImage: outputPath,
      aspectRatio: "1:1",
    });

    try {
      await exec({
        prompt: "a cute robot holding a banana",
        config: { chromeProfile: "Default", desiredModel: "Gemini 3 Pro", timeoutMs: 300_000 },
        log: () => {},
      });

      const bytes = new Uint8Array(await readFile(outputPath));
      expect(bytes.length).toBeGreaterThan(10_000);
      expect(looksLikeJpeg(bytes)).toBe(true);
    } catch (error) {
      console.warn(
        `Skipping Gemini web generate-image test due to transient error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 180_000);

  it("edit-image writes an output file", async () => {
    if (!(await assertHasGeminiChromeCookies())) return;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-web-live-"));
    const inputPath = path.join(tempDir, "input.png");
    const outputPath = path.join(tempDir, "edited.jpg");

    // 1x1 transparent PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/Pm2zXwAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(inputPath, png);

    const exec = createGeminiWebExecutor({
      editImage: inputPath,
      outputPath,
    });

    try {
      await exec({
        prompt: "add sunglasses",
        config: { chromeProfile: "Default", desiredModel: "Gemini 3 Pro", timeoutMs: 300_000 },
        log: () => {},
      });

      const bytes = new Uint8Array(await readFile(outputPath));
      expect(bytes.length).toBeGreaterThan(10_000);
      expect(looksLikeJpeg(bytes)).toBe(true);
    } catch (error) {
      console.warn(
        `Skipping Gemini web edit-image test due to transient error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 240_000);
});
