import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  persistDurableBrowserAnswer,
  publishBrowserCapture,
  type DurableBrowserAnswerReceipt,
} from "../../src/cli/durableAnswer.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
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

describe("publishBrowserCapture", () => {
  const receipt: DurableBrowserAnswerReceipt = {
    artifact: {
      kind: "transcript",
      path: "/tmp/durable-answer.md",
      sha256: "a".repeat(64),
      sizeBytes: 6,
    },
    sha256: "a".repeat(64),
    sizeBytes: 6,
  };

  test("uses one ordered receipt, publication, finalize, and authority transaction", async () => {
    const events: string[] = [];
    const capturedRuntime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const finalizedRuntime: BrowserRuntimeMetadata = { chromeTargetId: "finalized" };
    const result = await publishBrowserCapture({
      answerOptions: { sessionId: "session-1", answer: "answer" },
      transaction: {
        runtime: capturedRuntime,
        finalize: vi.fn(async () => {
          events.push("finalize");
          return { status: "completed" as const, runtime: finalizedRuntime };
        }),
        abort: vi.fn(async () => {
          events.push("abort");
          return { status: "completed" as const, runtime: {} };
        }),
      },
      persistAnswer: vi.fn(async () => {
        events.push("receipt");
        return receipt;
      }),
      prepare: async () => {
        events.push("prepare");
        return "prepared";
      },
      publish: async () => {
        events.push("publish");
      },
      persistRuntime: async (runtime) => {
        events.push(`runtime:${runtime.chromeTargetId}`);
      },
    });

    expect(events).toEqual(["receipt", "prepare", "publish", "finalize", "runtime:finalized"]);
    expect(result).toEqual({
      receipt,
      prepared: "prepared",
      finalization: { status: "completed", runtime: finalizedRuntime },
    });
  });

  test.each(["receipt", "prepare", "publish"] as const)(
    "aborts and persists exact pending authority when %s fails",
    async (failedStage) => {
      const events: string[] = [];
      const capturedRuntime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
      const pendingRuntime: BrowserRuntimeMetadata = {
        chromeTargetId: "pending",
        recoveryCleanupResult: { status: "pending" },
      };
      const failure = new Error(`${failedStage} failed`);
      const finalize = vi.fn();
      const abort = vi.fn(async () => {
        events.push("abort");
        return {
          status: "pending" as const,
          runtime: pendingRuntime,
          error: "target close remains retryable",
        };
      });

      const promise = publishBrowserCapture({
        answerOptions: { sessionId: "session-1", answer: "answer" },
        transaction: { runtime: capturedRuntime, finalize, abort },
        persistAnswer: vi.fn(async () => {
          events.push("receipt");
          if (failedStage === "receipt") throw failure;
          return receipt;
        }),
        prepare: async () => {
          events.push("prepare");
          if (failedStage === "prepare") throw failure;
          return undefined;
        },
        publish: async () => {
          events.push("publish");
          if (failedStage === "publish") throw failure;
        },
        persistRuntime: async (runtime) => {
          events.push(`runtime:${runtime.chromeTargetId}`);
        },
      });

      await expect(promise).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: {
          code: "publication-failed-cleanup-pending",
          runtime: pendingRuntime,
        },
      });
      expect(events.at(-2)).toBe("abort");
      expect(events.at(-1)).toBe("runtime:pending");
      expect(finalize).not.toHaveBeenCalled();
    },
  );

  test("persists runtime carried by a thrown abort instead of reverting to captured authority", async () => {
    const capturedRuntime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const pendingRuntime: BrowserRuntimeMetadata = { chromeTargetId: "abort-error-runtime" };
    const persistRuntime = vi.fn(async () => undefined);

    await expect(
      publishBrowserCapture({
        answerOptions: { sessionId: "session-1", answer: "answer" },
        transaction: {
          runtime: capturedRuntime,
          finalize: vi.fn(),
          abort: vi.fn(async () => {
            throw new BrowserAutomationError("abort transport failed", {
              runtime: pendingRuntime,
            });
          }),
        },
        persistAnswer: vi.fn(async () => {
          throw new Error("answer fsync failed");
        }),
        prepare: vi.fn(),
        publish: vi.fn(),
        persistRuntime,
      }),
    ).rejects.toMatchObject({
      details: { code: "publication-abort-failed", runtime: pendingRuntime },
    });
    expect(persistRuntime).toHaveBeenCalledWith(pendingRuntime);
  });

  test("turns finalize transport failure into persisted retryable authority", async () => {
    const capturedRuntime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const pendingRuntime: BrowserRuntimeMetadata = { chromeTargetId: "finalize-error-runtime" };
    const persistRuntime = vi.fn(async () => undefined);

    const result = await publishBrowserCapture({
      answerOptions: { sessionId: "session-1", answer: "answer" },
      transaction: {
        runtime: capturedRuntime,
        finalize: vi.fn(async () => {
          throw new BrowserAutomationError("settlement transport failed", {
            runtime: pendingRuntime,
          });
        }),
        abort: vi.fn(),
      },
      persistAnswer: vi.fn(async () => receipt),
      prepare: vi.fn(async () => undefined),
      publish: vi.fn(async () => undefined),
      persistRuntime,
    });

    expect(result.finalization).toMatchObject({
      status: "pending",
      runtime: pendingRuntime,
      error: expect.stringContaining("settlement transport failed"),
    });
    expect(persistRuntime).toHaveBeenCalledWith(pendingRuntime);
  });

  test("throws exact finalized authority when its durable projection fails", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = { chromeTargetId: "finalize-persist-runtime" };
    await expect(
      publishBrowserCapture({
        answerOptions: { sessionId: "session-1", answer: "answer" },
        transaction: {
          runtime: { chromeTargetId: "captured" },
          finalize: vi.fn(async () => ({
            status: "pending" as const,
            runtime: pendingRuntime,
            error: "cleanup pending",
          })),
          abort: vi.fn(),
        },
        persistAnswer: vi.fn(async () => receipt),
        prepare: vi.fn(async () => undefined),
        publish: vi.fn(async () => undefined),
        persistRuntime: vi.fn(async () => {
          throw new Error("metadata fsync failed");
        }),
      }),
    ).rejects.toMatchObject({
      details: {
        code: "runtime-authority-persistence-failed",
        runtime: pendingRuntime,
        cleanupStatus: "pending",
      },
    });
  });

  test("throws exact pending authority when abort authority persistence fails", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = { chromeTargetId: "unpersisted-pending" };
    await expect(
      publishBrowserCapture({
        answerOptions: { sessionId: "session-1", answer: "answer" },
        transaction: {
          runtime: { chromeTargetId: "captured" },
          finalize: vi.fn(),
          abort: vi.fn(async () => ({
            status: "pending" as const,
            runtime: pendingRuntime,
            error: "cleanup pending",
          })),
        },
        persistAnswer: vi.fn(async () => {
          throw new Error("receipt failed");
        }),
        prepare: vi.fn(),
        publish: vi.fn(),
        persistRuntime: vi.fn(async () => {
          throw new Error("metadata fsync failed");
        }),
      }),
    ).rejects.toMatchObject({
      details: {
        code: "abort-authority-persistence-failed",
        runtime: pendingRuntime,
      },
    });
  });
});
