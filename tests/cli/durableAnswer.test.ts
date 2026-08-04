import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.js";
import { sessionStore } from "../../src/sessionStore.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("persistDurableBrowserAnswer", () => {
  test("persists and verifies the exact captured answer bytes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-durable-answer-"));
    tempDirectories.push(directory);
    const sessionPaths = {
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    };
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue(sessionPaths);
    const answer = "  exact answer\nsecond line  ";
    const expectedHash = createHash("sha256").update(Buffer.from(answer, "utf8")).digest("hex");

    const receipt = await persistDurableBrowserAnswer({
      sessionId: "session-1",
      answer,
      logHeader: "[reattach] captured assistant response from existing Chrome tab",
    });

    expect(receipt.sha256).toBe(expectedHash);
    expect(receipt.artifact).toMatchObject({
      kind: "transcript",
      sha256: expectedHash,
      validation: { type: "generic", ok: true },
    });
    expect(await readFile(receipt.artifact.path, "utf8")).toBe(answer);
    expect(await readFile(sessionPaths.log, "utf8")).toBe(
      `[reattach] captured assistant response from existing Chrome tab\nAnswer:\n${answer}\n`,
    );
  });

  test("rejects a conflicting deterministic answer path instead of authorizing completion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-durable-answer-"));
    tempDirectories.push(directory);
    const sessionPaths = {
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    };
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue(sessionPaths);
    const answer = "captured answer";
    const expectedHash = createHash("sha256").update(Buffer.from(answer, "utf8")).digest("hex");
    const artifactsDirectory = path.join(directory, "artifacts");
    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(
      path.join(artifactsDirectory, `browser-answer-${expectedHash}.md`),
      "wrong bytes",
    );

    await expect(persistDurableBrowserAnswer({ sessionId: "session-1", answer })).rejects.toThrow(
      "Durable browser answer hash collision",
    );
  });
});
