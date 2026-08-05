import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  durableBrowserAnswerReceiptFromError,
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
  type DurableBrowserAnswerReceipt,
} from "../../src/cli/durableAnswer.js";
import { readBrowserCapturePublicationJournal } from "../../src/cli/browserPublicationJournal.js";
import type {
  BrowserRuntimeMetadata,
  SessionMetadata,
  SessionModelRun,
} from "../../src/sessionStore.js";
import { sessionStore } from "../../src/sessionStore.js";
import * as sessionManager from "../../src/sessionManager.js";

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

    expect(receipt.artifact.sha256).toBe(expectedHash);
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

  test("fsyncs an existing matching answer and its parent before returning its receipt", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-durable-answer-"));
    tempDirectories.push(directory);
    const sessionPaths = {
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    };
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue(sessionPaths);
    const answer = "retryable answer";
    const hash = createHash("sha256").update(Buffer.from(answer, "utf8")).digest("hex");
    const artifactsDirectory = path.join(directory, "artifacts");
    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(path.join(artifactsDirectory, `browser-answer-${hash}.md`), answer);
    const syncDirectory = vi.spyOn(sessionManager, "syncDirectoryIfSupported");

    const receipt = await persistDurableBrowserAnswer({ sessionId: "session-1", answer });

    expect(receipt.artifact.path).toBe(path.join(artifactsDirectory, `browser-answer-${hash}.md`));
    expect(syncDirectory).toHaveBeenCalledWith(artifactsDirectory);
  });

  test("rejects a pre-existing answer path substituted with a symlink", async () => {
    if (process.platform === "win32") return;
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
    const hash = createHash("sha256").update(Buffer.from(answer, "utf8")).digest("hex");
    const artifactsDirectory = path.join(directory, "artifacts");
    const sourcePath = path.join(directory, "answer-source.md");
    const answerPath = path.join(artifactsDirectory, `browser-answer-${hash}.md`);
    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(sourcePath, answer);
    await symlink(sourcePath, answerPath);

    await expect(persistDurableBrowserAnswer({ sessionId: "session-1", answer })).rejects.toThrow(
      "Durable browser answer is not a regular file",
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

describe("publishCompletedBrowserCapture", () => {
  const receipt: DurableBrowserAnswerReceipt = {
    artifact: {
      kind: "transcript",
      path: "/tmp/durable-answer.md",
      sha256: "a".repeat(64),
      sizeBytes: 6,
    },
  };

  function sessionResult(
    sessionId: string,
    updates: Partial<SessionMetadata> = {},
  ): SessionMetadata {
    return {
      ...updates,
      id: updates.id ?? sessionId,
      createdAt: updates.createdAt ?? "2026-01-01T00:00:00.000Z",
      status: updates.status ?? "running",
      options: updates.options ?? {},
    };
  }

  function modelRunResult(model: string, updates: Partial<SessionModelRun>): SessionModelRun {
    return {
      ...updates,
      model: updates.model ?? model,
      status: updates.status ?? "running",
    };
  }

  async function setupSession(): Promise<void> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-publication-"));
    tempDirectories.push(directory);
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue({
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    });
    vi.spyOn(sessionStore, "readSession").mockResolvedValue(null);
    vi.spyOn(sessionStore, "updateSession").mockImplementation(async (sessionId, updates) =>
      sessionResult(sessionId, updates),
    );
    vi.spyOn(sessionStore, "updateModelRun").mockImplementation(
      async (_sessionId, model, updates) => modelRunResult(model, updates),
    );
  }

  function browser(runtime: BrowserRuntimeMetadata): NonNullable<SessionMetadata["browser"]> {
    return {
      config: {
        desiredModel: "gpt-5.2-pro",
        chromePath: "/private/browser/chrome",
        remoteChrome: { host: "secret.internal", port: 9222 },
      },
      runtime,
    };
  }

  test("stages, binds FINALIZE, publishes, and only then executes finalize effects", async () => {
    await setupSession();
    const events: string[] = [];
    const capturedRuntime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const boundRuntime: BrowserRuntimeMetadata = {
      chromeTargetId: "bound",
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const finalizedRuntime: BrowserRuntimeMetadata = { conversationId: "conversation-1" };
    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) => {
      if (
        updates.status !== "completed" &&
        updates.browser?.runtime?.recoveryCleanupResult?.settlementMode === "finalize"
      ) {
        events.push("bind-local");
      }
      if (updates.status === "completed") events.push("publish");
      return sessionResult(sessionId, updates);
    });

    const result = await publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "answer" },
      transaction: {
        runtime: capturedRuntime,
        bindSettlement: vi.fn(async (mode) => {
          events.push(`bind:${mode}`);
          return boundRuntime;
        }),
        finalize: vi.fn(async () => {
          events.push("finalize");
          return { status: "completed" as const, runtime: finalizedRuntime };
        }),
        abort: vi.fn(async () => {
          events.push("abort");
          return { status: "completed" as const, runtime: {} };
        }),
      },
      browser: browser(capturedRuntime),
      persistAnswer: vi.fn(async () => {
        events.push("receipt");
        return receipt;
      }),
      prepareArtifacts: async () => {
        events.push("prepare");
        return [];
      },
      response: { status: "completed" },
    });

    expect(events).toEqual([
      "receipt",
      "prepare",
      "bind:finalize",
      "bind-local",
      "publish",
      "finalize",
      "publish",
    ]);
    expect(result).toMatchObject({
      published: true,
      receipt,
      finalization: { status: "completed", runtime: finalizedRuntime },
      runtimeAuthority: { status: "persisted" },
    });
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });

  test("binds ABORT before cleanup when pre-stage preparation fails", async () => {
    await setupSession();
    const events: string[] = [];
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const promise = publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "answer" },
      transaction: {
        runtime,
        bindSettlement: vi.fn(async (mode: "finalize" | "abort") => {
          events.push(`bind:${mode}`);
          return {
            ...runtime,
            recoveryCleanupResult: { status: "pending" as const, settlementMode: mode },
          };
        }),
        finalize: vi.fn(),
        abort: vi.fn(async () => {
          events.push("abort");
          return { status: "completed" as const, runtime: {} };
        }),
      },
      browser: browser(runtime),
      persistAnswer: vi.fn(async () => {
        events.push("receipt");
        return receipt;
      }),
      prepareArtifacts: async () => {
        events.push("prepare");
        throw new Error("artifact fsync failed");
      },
    });

    await expect(promise).rejects.toThrow("staging failed after the answer became durable");
    expect(events).toEqual(["receipt", "prepare", "bind:abort", "abort"]);
    await promise.catch((error: unknown) => {
      expect(durableBrowserAnswerReceiptFromError(error)).toEqual(receipt);
    });
  });

  test("keeps FINALIZE authority recoverable when completed projection is interrupted", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const bindSettlement = vi.fn(async () => ({
      ...runtime,
      recoveryCleanupResult: { status: "pending" as const, settlementMode: "finalize" as const },
    }));
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const abort = vi.fn();
    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) => {
      if (updates.status === "completed") throw new Error("metadata fsync failed");
      return sessionResult(sessionId, updates);
    });

    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "answer" },
        transaction: { runtime, bindSettlement, finalize, abort },
        browser: browser(runtime),
        persistAnswer: vi.fn(async () => receipt),
      }),
    ).rejects.toMatchObject({ details: { code: "finalize-bound-publication-pending" } });
    expect(abort).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "finalize-bound",
      receipt,
    });

    vi.mocked(sessionStore.updateSession).mockResolvedValue(sessionResult("session-1"));
    const recovered = await publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "ignored on recovery" },
      transaction: { runtime, bindSettlement, finalize, abort },
      browser: browser(runtime),
      persistAnswer: vi.fn(),
    });
    expect(recovered.published).toBe(true);
    expect(bindSettlement).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  test("retries the local FINALIZE projection before completed publication", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const boundRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const bindSettlement = vi.fn(async () => boundRuntime);
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const abort = vi.fn();
    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) => {
      if (
        updates.status !== "completed" &&
        updates.browser?.runtime?.recoveryCleanupResult?.settlementMode === "finalize"
      ) {
        throw new Error("local runtime fsync failed");
      }
      return sessionResult(sessionId, updates);
    });

    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "answer" },
        transaction: { runtime, bindSettlement, finalize, abort },
        browser: browser(runtime),
        persistAnswer: vi.fn(async () => receipt),
      }),
    ).rejects.toMatchObject({ details: { code: "finalize-local-binding-persistence-failed" } });
    expect(finalize).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "finalize-bound",
      runtime: { recoveryCleanupResult: { settlementMode: "finalize" } },
    });

    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) =>
      sessionResult(sessionId, updates),
    );
    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "ignored on recovery" },
        transaction: { runtime, bindSettlement, finalize, abort },
        browser: browser(runtime),
        persistAnswer: vi.fn(),
      }),
    ).resolves.toMatchObject({ published: true, finalization: { status: "completed" } });
    expect(bindSettlement).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  test("retains pending cleanup authority while completed metadata is audit-only", async () => {
    await setupSession();
    const capturedRuntime: BrowserRuntimeMetadata = {
      chromePid: 42,
      chromeHost: "secret.internal",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://secret.internal:9222/devtools/browser/token",
      chromeProfileRoot: "/private/profile",
      userDataDir: "/private/user-data",
      chromeTargetId: "target-secret",
      tabUrl: "https://chatgpt.com/c/conversation-1",
      conversationId: "conversation-1",
      recoveryCleanupResources: [
        {
          chromePid: 42,
          chromeHost: "secret.internal",
          chromePort: 9222,
          chromeBrowserWSEndpoint: "ws://secret.internal:9222/devtools/browser/token",
          userDataDir: "/private/user-data",
          chromeTargetId: "target-secret",
          targetCloseCapability: {
            version: 1,
            generationId: "generation-secret",
            capabilityId: "capability-secret",
          },
          recoveryCleanup: { ownsTarget: true, profileKind: "none", keepBrowser: false },
        },
      ],
    };
    const pendingRuntime: BrowserRuntimeMetadata = {
      ...capturedRuntime,
      recoveryCleanupResult: {
        status: "pending",
        settlementMode: "finalize",
        error: "ws://secret.internal:9222 /private/user-data token=super-secret cleanup failed",
      },
    };
    const updates: Partial<SessionMetadata>[] = [];
    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, patch) => {
      updates.push(patch);
      return sessionResult(sessionId, patch);
    });

    const result = await publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "answer" },
      transaction: {
        runtime: capturedRuntime,
        bindSettlement: vi.fn(async () => pendingRuntime),
        finalize: vi.fn(async () => ({
          status: "pending" as const,
          runtime: pendingRuntime,
          error: "cleanup pending",
        })),
        abort: vi.fn(),
      },
      browser: browser(capturedRuntime),
      persistAnswer: vi.fn(async () => receipt),
    });

    expect(result.finalization.status).toBe("pending");
    const completedProjection = updates.findLast((patch) => patch.status === "completed");
    expect(completedProjection?.browser?.config).toEqual({
      desiredModel: "gpt-5.2-pro",
      modelStrategy: undefined,
      researchMode: undefined,
      thinkingTime: undefined,
      archiveConversations: undefined,
    });
    expect(completedProjection?.browser?.runtime).toMatchObject({
      conversationId: "conversation-1",
      recoveryCleanupResult: {
        status: "pending",
        settlementMode: "finalize",
      },
    });
    expect(completedProjection?.browser?.runtime).not.toHaveProperty("chromePid");
    expect(completedProjection?.browser?.runtime).not.toHaveProperty("chromeBrowserWSEndpoint");
    expect(completedProjection?.browser?.runtime).not.toHaveProperty("tabUrl");
    expect(completedProjection?.browser?.runtime).not.toHaveProperty("userDataDir");
    expect(completedProjection?.browser?.runtime).not.toHaveProperty("chromeTargetId");
    expect(completedProjection?.browser?.runtime).not.toHaveProperty("recoveryCleanupResources");
    expect(completedProjection?.browser?.runtime?.recoveryCleanupResult?.error).not.toContain(
      "/private/user-data",
    );
    expect(completedProjection?.browser?.runtime?.recoveryCleanupResult?.error).not.toContain(
      "secret.internal",
    );
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "cleanup-pending",
      runtime: { chromePid: 42, chromeTargetId: "target-secret" },
    });
  });

  test("returns explicit pending authority state after post-publication persistence retries fail", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { conversationId: "conversation-1" };
    let completedWrites = 0;
    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) => {
      if (updates.status === "completed") {
        completedWrites += 1;
        if (completedWrites > 1) throw new Error("metadata fsync failed");
      }
      return sessionResult(sessionId, updates);
    });

    const result = await publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "answer" },
      transaction: {
        runtime,
        bindSettlement: vi.fn(async () => runtime),
        finalize: vi.fn(async () => ({
          status: "pending" as const,
          runtime: {
            ...runtime,
            recoveryCleanupResult: {
              status: "pending" as const,
              settlementMode: "finalize" as const,
            },
          },
          error: "cleanup pending",
        })),
        abort: vi.fn(),
      },
      browser: browser(runtime),
      persistAnswer: vi.fn(async () => receipt),
    });

    expect(result).toMatchObject({
      published: true,
      runtimeAuthority: { status: "pending", error: "metadata fsync failed" },
    });
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "cleanup-pending",
    });
  });
});
