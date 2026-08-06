import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BrowserPublicationTransaction,
  durableBrowserAnswerReceiptFromError,
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
  persistBrowserCaptureFinalizationState,
  readDurableBrowserAnswer,
  verifiedDurableBrowserAnswerReceiptFromError,
} from "../../src/cli/durableAnswer.js";
import type { DurableBrowserAnswerReceipt } from "../../src/cli/durableAnswer.js";
import * as browserPublicationJournal from "../../src/cli/browserPublicationJournal.js";
import {
  BrowserPublicationJournalStore,
  isBrowserPublicationAcknowledged,
  journalHasFinalizeAuthorityForReceipt,
  readBrowserCapturePublicationJournal,
  reduceBrowserPublicationEvent,
} from "../../src/cli/browserPublicationJournal.js";
import type { BrowserCapturePublicationJournal } from "../../src/cli/browserPublicationJournal.js";
import type {
  BrowserRuntimeMetadata,
  SessionMetadata,
  SessionModelRun,
} from "../../src/sessionStore.js";
import { sessionStore } from "../../src/sessionStore.js";
import * as sessionStoreModule from "../../src/sessionStore.js";
import * as sessionManager from "../../src/sessionManager.js";
import * as fsDurability from "../../src/fsDurability.js";
import {
  OwnedBrowserResourceTransaction,
  completedBrowserCaptureCleanup,
} from "../../src/browser/ownedBrowserResources.js";
import { createReattachSettlement } from "../../src/browser/reattachSettlement.js";
import type { ReattachResult } from "../../src/browser/reattachContracts.js";
import {
  hasRetainedFilesystemLockRelease,
  retainFilesystemLockRelease,
  __test__ as lockReleaseJournalTest,
} from "../../src/browser/filesystemLockReleaseJournal.js";
import {
  __test__ as targetCloseAuthorityTest,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "../../src/browser/types.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
  lockReleaseJournalTest.clearRetainedFilesystemLockReleases();
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

  test("journals and fsyncs the exact answer before pre-archive preparation resolves", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-prearchive-answer-"));
    tempDirectories.push(directory);
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue({
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    });
    vi.spyOn(sessionStore, "readSession").mockResolvedValue(null);
    const publication = new BrowserPublicationTransaction();
    const answer = "exact local pre-archive answer";

    const receipt = await publication.prepareDurableCapture({
      answer: { sessionId: "session-1", answer },
      runtime: { conversationId: "conversation-1" },
      browser: { config: {}, runtime: { conversationId: "conversation-1" } },
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      response: { status: "completed" },
      elapsedMs: 250,
    });

    expect(await readDurableBrowserAnswer(receipt)).toBe(answer);
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "preparing",
      receipt,
      runtime: { conversationId: "conversation-1" },
    });
    expect(publication.isRemotePublicationAcknowledged()).toBe(true);
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
    const syncDirectory = vi.spyOn(fsDurability, "syncDirectory");

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

describe("browser publication phase model", () => {
  const artifact = {
    kind: "transcript" as const,
    path: "/tmp/browser-answer.md",
    sha256: "a".repeat(64),
    sizeBytes: 6,
  };
  const preparing = reduceBrowserPublicationEvent(null, {
    type: "prepare",
    journal: {
      sessionId: "session-1",
      receipt: { artifact },
      artifacts: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      browserAudit: { runtime: {} },
      runtime: {},
    },
  });
  const staged = reduceBrowserPublicationEvent(preparing, {
    type: "answer-staged",
    receipt: { artifact },
    artifacts: [artifact],
  });
  const finalizeBound = reduceBrowserPublicationEvent(staged, {
    type: "finalize-bound",
    receipt: { artifact },
    settlementMode: "finalize",
    runtime: { recoveryCleanupResult: { status: "pending", settlementMode: "finalize" } },
    browserAudit: { runtime: {} },
  });

  test("acknowledges only bound journals backed by the matching terminal projection", () => {
    const published = reduceBrowserPublicationEvent(finalizeBound, {
      type: "completed-session-persisted",
      receipt: { artifact },
      completedSessionPersisted: true,
    });
    const cleanupPending = reduceBrowserPublicationEvent(published, {
      type: "cleanup-finalization-persisted",
      completedSessionPersisted: true,
      finalization: {
        status: "pending",
        runtime: finalizeBound.runtime,
        errorCode: "browser-cleanup-finalize-pending",
        errorMessage: "cleanup remains pending",
      },
    });
    const terminalMetadata: SessionMetadata = {
      id: "session-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      options: {},
      completedAt: finalizeBound.completedAt,
      artifacts: [artifact],
    };

    expect(isBrowserPublicationAcknowledged(preparing, terminalMetadata)).toBe(false);
    expect(isBrowserPublicationAcknowledged(staged, terminalMetadata)).toBe(false);
    expect(isBrowserPublicationAcknowledged(finalizeBound, terminalMetadata)).toBe(true);
    expect(isBrowserPublicationAcknowledged(published, terminalMetadata)).toBe(true);
    expect(isBrowserPublicationAcknowledged(cleanupPending, terminalMetadata)).toBe(true);
    expect(isBrowserPublicationAcknowledged(published, null)).toBe(false);
  });

  test("grants FINALIZE authority only to the journal's exact durable receipt", () => {
    const published = reduceBrowserPublicationEvent(finalizeBound, {
      type: "completed-session-persisted",
      receipt: { artifact },
      completedSessionPersisted: true,
    });
    const cleanupPending = reduceBrowserPublicationEvent(published, {
      type: "cleanup-finalization-persisted",
      completedSessionPersisted: true,
      finalization: {
        status: "pending",
        runtime: finalizeBound.runtime,
        errorCode: "browser-cleanup-finalize-pending",
        errorMessage: "cleanup remains pending",
      },
    });
    const differentReceipt = {
      artifact: { ...artifact, path: "/tmp/different-browser-answer.md" },
    };

    expect(journalHasFinalizeAuthorityForReceipt(preparing, { artifact })).toBe(false);
    expect(journalHasFinalizeAuthorityForReceipt(staged, { artifact })).toBe(false);
    expect(journalHasFinalizeAuthorityForReceipt(finalizeBound, { artifact })).toBe(true);
    expect(journalHasFinalizeAuthorityForReceipt(published, { artifact })).toBe(true);
    expect(journalHasFinalizeAuthorityForReceipt(cleanupPending, { artifact })).toBe(true);
    expect(journalHasFinalizeAuthorityForReceipt(finalizeBound, differentReceipt)).toBe(false);
  });

  test("reduces every legal publication edge", () => {
    const published = reduceBrowserPublicationEvent(finalizeBound, {
      type: "completed-session-persisted",
      receipt: { artifact },
      completedSessionPersisted: true,
    });
    const pendingFromBound = reduceBrowserPublicationEvent(finalizeBound, {
      type: "cleanup-finalization-persisted",
      completedSessionPersisted: true,
      finalization: {
        status: "pending",
        runtime: finalizeBound.runtime,
        errorCode: "browser-cleanup-finalize-pending",
        errorMessage: "cleanup remains pending",
      },
    });
    const pendingFromPublished = reduceBrowserPublicationEvent(published, {
      type: "cleanup-finalization-persisted",
      completedSessionPersisted: true,
      finalization: {
        status: "pending",
        runtime: finalizeBound.runtime,
        errorCode: "browser-cleanup-finalize-pending",
        errorMessage: "cleanup remains pending",
      },
    });
    const retriedPending = reduceBrowserPublicationEvent(pendingFromPublished, {
      type: "cleanup-finalization-persisted",
      completedSessionPersisted: true,
      finalization: {
        status: "pending",
        runtime: finalizeBound.runtime,
        errorCode: "browser-cleanup-finalize-pending",
        errorMessage: "cleanup remains pending",
      },
    });
    const completed = reduceBrowserPublicationEvent(retriedPending, {
      type: "cleanup-finalization-persisted",
      completedSessionPersisted: true,
      finalization: { status: "completed", runtime: {} },
    });

    expect([preparing.phase, staged.phase, finalizeBound.phase]).toEqual([
      "preparing",
      "staged",
      "finalize-bound",
    ]);
    expect(published.phase).toBe("published");
    expect(pendingFromBound.phase).toBe("cleanup-pending");
    expect(retriedPending.phase).toBe("cleanup-pending");
    expect(completed).toMatchObject({ phase: "published", cleanupFinalizationPersisted: true });
  });

  test("allows abort-clear only from preparing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-publication-abort-"));
    tempDirectories.push(directory);
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue({
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    });
    const store = new BrowserPublicationJournalStore("session-1");
    const persisted = await store.transition(null, {
      type: "prepare",
      journal: {
        sessionId: "session-1",
        receipt: { artifact },
        artifacts: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        browserAudit: { runtime: {} },
        runtime: {},
      },
    });

    await expect(
      store.remove(persisted, {
        type: "retire-completed-publication",
        receipt: persisted.receipt,
        completedSessionPersisted: true,
      }),
    ).rejects.toThrow("preparing -> retire-completed-publication");
    await store.remove(persisted, { type: "abort-preparation", receipt: persisted.receipt });
    await expect(store.read()).resolves.toBeNull();
  });

  test("retains receipt authority when completed journal retirement durability is unknown", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-publication-retirement-"));
    tempDirectories.push(directory);
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue({
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    });
    const store = new BrowserPublicationJournalStore("session-1");
    const persistedPreparing = await store.transition(null, {
      type: "prepare",
      journal: {
        sessionId: "session-1",
        receipt: { artifact },
        artifacts: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        browserAudit: { runtime: {} },
        runtime: {},
      },
    });
    const staged = await store.transition(persistedPreparing, {
      type: "answer-staged",
      receipt: persistedPreparing.receipt,
      artifacts: [artifact],
    });
    const bound = await store.transition(staged, {
      type: "finalize-bound",
      receipt: staged.receipt,
      settlementMode: "finalize",
      runtime: {},
      browserAudit: { runtime: {} },
    });
    const published = await store.transition(bound, {
      type: "completed-session-persisted",
      receipt: bound.receipt,
      completedSessionPersisted: true,
    });
    vi.spyOn(sessionStore, "readSession").mockResolvedValue({
      id: "session-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: published.completedAt,
      status: "completed",
      options: {},
      artifacts: [artifact],
    });
    const publication = await BrowserPublicationTransaction.open("session-1");
    vi.spyOn(fsDurability, "syncDirectory").mockRejectedValueOnce(
      new Error("journal directory sync outcome unknown"),
    );

    await expect(publication.clear()).rejects.toThrow("journal directory sync outcome unknown");

    expect(await store.read()).toBeNull();
    expect(publication.journal).toEqual(published);
    expect(publication.isRemotePublicationAcknowledged()).toBe(true);
    const differentArtifact = {
      ...artifact,
      path: "/tmp/different-browser-answer.md",
      sha256: "b".repeat(64),
    };
    const differentJournal = store.reduce(null, {
      type: "prepare",
      journal: {
        sessionId: "session-1",
        receipt: { artifact: differentArtifact },
        artifacts: [],
        completedAt: "2026-01-02T00:00:00.000Z",
        browserAudit: { runtime: {} },
        runtime: {},
      },
    });
    expect(() => publication.observe(differentJournal)).toThrow(
      "receipt does not match its publication intent",
    );
  });

  test("rejects illegal edges and missing phase payloads", () => {
    expect(() =>
      reduceBrowserPublicationEvent(null, {
        type: "answer-staged",
        receipt: { artifact },
        artifacts: [artifact],
      }),
    ).toThrow("null -> answer-staged");
    expect(() =>
      reduceBrowserPublicationEvent(preparing, {
        type: "completed-session-persisted",
        receipt: { artifact },
        completedSessionPersisted: true,
      }),
    ).toThrow("preparing -> completed-session-persisted");
    expect(() =>
      reduceBrowserPublicationEvent(preparing, {
        type: "answer-staged",
        receipt: { artifact },
        artifacts: [],
      }),
    ).toThrow("staged requires its durable answer artifact");
    expect(() =>
      reduceBrowserPublicationEvent(preparing, {
        type: "answer-staged",
        receipt: { artifact: { ...artifact, sha256: "b".repeat(64) } },
        artifacts: [artifact],
      }),
    ).toThrow("does not match its publication intent");
    expect(() =>
      reduceBrowserPublicationEvent(staged, {
        type: "finalize-bound",
        receipt: { artifact },
        runtime: {},
        browserAudit: { runtime: {} },
      } as never),
    ).toThrow("finalize-bound requires FINALIZE settlement proof");
    expect(() =>
      reduceBrowserPublicationEvent(staged, {
        type: "finalize-bound",
        receipt: { artifact },
        settlementMode: "finalize",
        runtime: { recoveryCleanupResult: { status: "pending", settlementMode: "abort" } },
        browserAudit: { runtime: {} },
      }),
    ).toThrow("cannot carry ABORT settlement authority");
    expect(() =>
      reduceBrowserPublicationEvent(finalizeBound, {
        type: "completed-session-persisted",
        receipt: { artifact },
      } as never),
    ).toThrow("published requires completed session proof");
    expect(() =>
      reduceBrowserPublicationEvent(finalizeBound, {
        type: "cleanup-finalization-persisted",
        completedSessionPersisted: true,
        finalization: {
          status: "pending",
          runtime: finalizeBound.runtime,
          errorCode: "browser-cleanup-finalize-pending",
        },
      } as never),
    ).toThrow("cleanup-pending requires an error message");
  });

  test("restart rejects finalize-bound journals without settlement proof", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-publication-unbound-"));
    tempDirectories.push(directory);
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue({
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    });
    const malformed: Record<string, unknown> = { ...finalizeBound };
    delete malformed.finalizeSettlementMode;
    await writeFile(
      path.join(directory, "browser-capture-publication.json"),
      JSON.stringify(malformed),
    );

    await expect(readBrowserCapturePublicationJournal("session-1")).rejects.toThrow(
      "finalize-bound requires FINALIZE settlement proof",
    );
  });

  test("restart rejects cleanup-pending journals without required failure metadata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-publication-invalid-"));
    tempDirectories.push(directory);
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue({
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    });
    await writeFile(
      path.join(directory, "browser-capture-publication.json"),
      JSON.stringify({
        ...finalizeBound,
        phase: "cleanup-pending",
        cleanupFinalizationPersisted: true,
        completedSessionPersisted: true,
        cleanupErrorCode: "browser-cleanup-finalize-pending",
      }),
    );

    await expect(readBrowserCapturePublicationJournal("session-1")).rejects.toThrow(
      "cleanup-pending requires an error message",
    );
  });

  test("restart upgrades legacy publication proofs before validation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-publication-legacy-"));
    tempDirectories.push(directory);
    vi.spyOn(sessionStore, "getPaths").mockResolvedValue({
      dir: directory,
      metadata: path.join(directory, "metadata.json"),
      log: path.join(directory, "session.log"),
      request: path.join(directory, "request.json"),
    });
    const published = reduceBrowserPublicationEvent(finalizeBound, {
      type: "completed-session-persisted",
      receipt: { artifact },
      completedSessionPersisted: true,
    });
    const legacy: Record<string, unknown> = { ...published, version: 1 };
    delete legacy.finalizeSettlementMode;
    delete legacy.completedSessionPersisted;
    await writeFile(
      path.join(directory, "browser-capture-publication.json"),
      JSON.stringify(legacy),
    );

    await expect(readBrowserCapturePublicationJournal("session-1")).resolves.toMatchObject({
      version: 2,
      phase: "published",
      finalizeSettlementMode: "finalize",
      completedSessionPersisted: true,
    });
  });
});

describe("publishCompletedBrowserCapture", () => {
  function acceptPreparedReceipt(events?: string[]) {
    return vi.fn(
      async (
        _options: Parameters<typeof persistDurableBrowserAnswer>[0],
        expectedReceipt?: DurableBrowserAnswerReceipt,
      ) => {
        events?.push("receipt");
        if (!expectedReceipt) throw new Error("publication intent receipt missing");
        return expectedReceipt;
      },
    );
  }

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
    vi.spyOn(sessionStoreModule, "commitSessionModelProjection").mockImplementation(
      async (sessionId, projection) => {
        const baseSession = await sessionStore.updateSession(sessionId, projection.session);
        if (!projection.model) return { session: baseSession };
        const model = await sessionStore.updateModelRun(
          sessionId,
          projection.model.model,
          projection.model.updates,
        );
        return {
          session: {
            ...baseSession,
            models: [model],
            modelProjectionAuthority: "session",
          },
          model,
        };
      },
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

  async function installPublicationJournal(
    phase: "published" | "cleanup-pending",
    artifact: DurableBrowserAnswerReceipt["artifact"],
    runtime: BrowserRuntimeMetadata,
    completedAt: string,
  ): Promise<BrowserCapturePublicationJournal> {
    const store = new BrowserPublicationJournalStore("session-1");
    const preparing = store.reduce(null, {
      type: "prepare",
      journal: {
        sessionId: "session-1",
        receipt: { artifact },
        artifacts: [],
        completedAt,
        browserAudit: browser(runtime),
        runtime,
      },
    });
    const staged = store.reduce(preparing, {
      type: "answer-staged",
      receipt: { artifact },
      artifacts: [artifact],
    });
    const finalizeBound = store.reduce(staged, {
      type: "finalize-bound",
      receipt: { artifact },
      settlementMode: "finalize",
      runtime,
      browserAudit: browser(runtime),
    });
    return phase === "published"
      ? store.transition(finalizeBound, {
          type: "completed-session-persisted",
          receipt: { artifact },
          completedSessionPersisted: true,
        })
      : store.transition(finalizeBound, {
          type: "cleanup-finalization-persisted",
          completedSessionPersisted: true,
          finalization: {
            status: "pending",
            runtime,
            errorCode: "browser-cleanup-finalize-pending",
            errorMessage: runtime.recoveryCleanupResult?.error ?? "cleanup remains pending",
          },
        });
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

    const persistAnswer = acceptPreparedReceipt(events);
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
      persistAnswer,
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
      receipt: persistAnswer.mock.calls[0]?.[1],
      finalization: { status: "completed", runtime: finalizedRuntime },
      projection: { status: "persisted" },
      finalizationPersistence: { status: "persisted" },
    });
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });

  test("restart discovers the exact answer after a crash before artifact preparation", async () => {
    await setupSession();
    const answer = "answer durable before preparation";
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const bindSettlement = vi.fn(async (mode: "finalize" | "abort") => ({
      ...runtime,
      recoveryCleanupResult: { status: "pending" as const, settlementMode: mode },
    }));
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime }));
    let answerBecameDurable!: () => void;
    const durableBoundary = new Promise<void>((resolve) => {
      answerBecameDurable = resolve;
    });
    const interruptedPreparation = vi.fn(async () => []);
    const persistThenCrash = vi.fn(
      async (
        answerOptions: Parameters<typeof persistDurableBrowserAnswer>[0],
        expectedReceipt?: DurableBrowserAnswerReceipt,
      ) => {
        await persistDurableBrowserAnswer(answerOptions, expectedReceipt);
        answerBecameDurable();
        return new Promise<DurableBrowserAnswerReceipt>(() => undefined);
      },
    );

    const interrupted = publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer },
      transaction: { runtime, bindSettlement, finalize, abort },
      browser: browser(runtime),
      persistAnswer: persistThenCrash,
      prepareArtifacts: interruptedPreparation,
    });
    void interrupted.catch(() => undefined);
    await durableBoundary;

    const intent = await readBrowserCapturePublicationJournal("session-1");
    expect(intent).toMatchObject({
      phase: "preparing",
      receipt: {
        artifact: {
          path: expect.stringContaining("browser-answer-"),
          sha256: createHash("sha256").update(answer).digest("hex"),
          sizeBytes: Buffer.byteLength(answer),
        },
      },
    });
    if (!intent) throw new Error("publication intent missing at durable answer boundary");
    expect(await readFile(intent.receipt.artifact.path, "utf8")).toBe(answer);
    expect(await readDurableBrowserAnswer(intent.receipt)).toBe(answer);
    expect(interruptedPreparation).not.toHaveBeenCalled();

    const recoveredPreparation = vi.fn(async () => []);
    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer },
        transaction: { runtime, bindSettlement, finalize, abort },
        browser: browser(runtime),
        persistAnswer: persistDurableBrowserAnswer,
        prepareArtifacts: recoveredPreparation,
      }),
    ).resolves.toMatchObject({ published: true, receipt: intent.receipt });
    expect(recoveredPreparation).toHaveBeenCalledTimes(1);
    expect(bindSettlement).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });

  test("reconciles an answer write that throws after its atomic rename", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const prepareArtifacts = vi.fn(async () => []);
    const writeFileAtomicDurable = sessionManager.writeFileAtomicDurable;
    let injectedFailure = false;
    vi.spyOn(sessionManager, "writeFileAtomicDurable").mockImplementation(
      async (targetPath, data, mode) => {
        await writeFileAtomicDurable(targetPath, data, mode);
        if (!injectedFailure && path.basename(targetPath).startsWith("browser-answer-")) {
          injectedFailure = true;
          throw new Error("directory fsync failed after answer rename");
        }
      },
    );

    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "renamed answer" },
        transaction: {
          runtime,
          bindSettlement: vi.fn(async () => runtime),
          finalize,
          abort,
        },
        browser: browser(runtime),
        prepareArtifacts,
      }),
    ).resolves.toMatchObject({ published: true });

    expect(injectedFailure).toBe(true);
    expect(prepareArtifacts).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });

  test("reconciles a preparing journal write that throws after its atomic rename", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const prepareArtifacts = vi.fn(async () => []);
    const writeFileAtomicDurable = sessionManager.writeFileAtomicDurable;
    let injectedFailure = false;
    vi.spyOn(sessionManager, "writeFileAtomicDurable").mockImplementation(
      async (targetPath, data, mode) => {
        await writeFileAtomicDurable(targetPath, data, mode);
        if (!injectedFailure && path.basename(targetPath) === "browser-capture-publication.json") {
          injectedFailure = true;
          throw new Error("directory fsync failed after journal rename");
        }
      },
    );

    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "journaled answer" },
        transaction: {
          runtime,
          bindSettlement: vi.fn(async () => runtime),
          finalize,
          abort,
        },
        browser: browser(runtime),
        persistAnswer: acceptPreparedReceipt(),
        prepareArtifacts,
      }),
    ).resolves.toMatchObject({ published: true });

    expect(injectedFailure).toBe(true);
    expect(prepareArtifacts).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });
  test("does not verify an unreconciled preparing receipt before answer persistence", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    vi.spyOn(browserPublicationJournal, "readBrowserCapturePublicationJournal")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("journal reconciliation read failed"));
    vi.spyOn(sessionManager, "writeFileAtomicDurable").mockRejectedValueOnce(
      new Error("journal write failed before answer persistence"),
    );
    const persistAnswer = acceptPreparedReceipt();
    const promise = publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "answer never persisted" },
      transaction: {
        runtime,
        bindSettlement: vi.fn(),
        finalize: vi.fn(),
        abort: vi.fn(),
      },
      browser: browser(runtime),
      persistAnswer,
    });

    await expect(promise).rejects.toThrow("publication recovery remains pending");
    await promise.catch(async (error: unknown) => {
      expect(durableBrowserAnswerReceiptFromError(error)).toMatchObject({
        artifact: { validation: { ok: true } },
      });
      await expect(verifiedDurableBrowserAnswerReceiptFromError(error)).resolves.toBeUndefined();
    });
    expect(persistAnswer).not.toHaveBeenCalled();
  });

  test("clears the preparing journal when answer persistence fails before a receipt", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const abortBoundRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
    };
    const bindSettlement = vi.fn(async () => abortBoundRuntime);
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));

    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "answer never persisted" },
        transaction: {
          runtime,
          bindSettlement,
          finalize: vi.fn(),
          abort,
        },
        browser: browser(runtime),
        persistAnswer: vi.fn(async () => {
          throw new Error("answer write failed before rename");
        }),
      }),
    ).rejects.toThrow("answer write failed before rename");

    expect(bindSettlement).toHaveBeenCalledWith("abort");
    expect(abort).toHaveBeenCalledOnce();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        browser: expect.objectContaining({ runtime: abortBoundRuntime }),
      }),
    );
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });

  test("clears a crashed preparing intent when restart recaptures different bytes", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    let answerPersistenceStarted!: () => void;
    const persistenceBoundary = new Promise<void>((resolve) => {
      answerPersistenceStarted = resolve;
    });
    const interrupted = publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "first captured answer" },
      transaction: {
        runtime,
        bindSettlement: vi.fn(async () => runtime),
        finalize: vi.fn(),
        abort: vi.fn(),
      },
      browser: browser(runtime),
      persistAnswer: vi.fn(async () => {
        answerPersistenceStarted();
        return new Promise<DurableBrowserAnswerReceipt>(() => undefined);
      }),
    });
    void interrupted.catch(() => undefined);
    await persistenceBoundary;
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "preparing",
    });

    const abortBoundRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
    };
    const bindSettlement = vi.fn(async () => abortBoundRuntime);
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "different recaptured answer" },
        transaction: {
          runtime,
          bindSettlement,
          finalize: vi.fn(),
          abort,
        },
        browser: browser(runtime),
      }),
    ).rejects.toThrow("receipt does not match its publication intent");

    expect(bindSettlement).toHaveBeenCalledWith("abort");
    expect(abort).toHaveBeenCalledOnce();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        browser: expect.objectContaining({ runtime: abortBoundRuntime }),
      }),
    );
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });

  test("retires preparing intent after ABORT binding and before cleanup effects", async () => {
    await setupSession();
    const events: string[] = [];
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    let preparedReceipt: DurableBrowserAnswerReceipt | undefined;
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
          expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
          events.push("abort");
          return { status: "completed" as const, runtime: {} };
        }),
      },
      browser: browser(runtime),
      persistAnswer: vi.fn(
        async (
          options: Parameters<typeof persistDurableBrowserAnswer>[0],
          expectedReceipt?: DurableBrowserAnswerReceipt,
        ) => {
          events.push("receipt");
          if (!expectedReceipt) throw new Error("publication intent receipt missing");
          preparedReceipt = expectedReceipt;
          return persistDurableBrowserAnswer(options, expectedReceipt);
        },
      ),
      prepareArtifacts: async () => {
        events.push("prepare");
        throw new Error("artifact fsync failed");
      },
    });

    await expect(promise).rejects.toThrow("staging failed after the answer became durable");
    expect(events).toEqual(["receipt", "prepare", "bind:abort", "abort"]);
    await promise.catch(async (error: unknown) => {
      expect(durableBrowserAnswerReceiptFromError(error)).toEqual(preparedReceipt);
      await expect(verifiedDurableBrowserAnswerReceiptFromError(error)).resolves.toEqual(
        preparedReceipt,
      );
    });
    expect(sessionStore.updateSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: preparedReceipt?.artifact.path,
            sha256: preparedReceipt?.artifact.sha256,
          }),
        ]),
      }),
    );
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });

  test("cannot recover-publish after terminal ABORT projection crashes", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    const boundRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
    };
    let terminalProjection: BrowserRuntimeMetadata | undefined;
    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) => {
      const projectedRuntime = updates.browser?.runtime;
      if (
        projectedRuntime &&
        !projectedRuntime.recoveryCleanupResources?.length &&
        !projectedRuntime.recoveryCleanupResult
      ) {
        terminalProjection = projectedRuntime;
        expect(await readBrowserCapturePublicationJournal(sessionId)).toBeNull();
        throw new Error("crash after terminal abort projection");
      }
      return sessionResult(sessionId, updates);
    });
    const finalize = vi.fn();

    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "abandoned answer" },
        transaction: {
          runtime,
          bindSettlement: vi.fn(async () => boundRuntime),
          finalize,
          abort: vi.fn(async () => ({ status: "completed" as const, runtime: {} })),
        },
        browser: browser(runtime),
        persistAnswer: async (options, expectedReceipt) =>
          persistDurableBrowserAnswer(options, expectedReceipt),
        prepareArtifacts: async () => {
          throw new Error("artifact preparation failed");
        },
      }),
    ).rejects.toMatchObject({ details: { code: "abort-authority-persistence-failed" } });

    expect(terminalProjection).toEqual({});
    expect(finalize).not.toHaveBeenCalled();
    await expect(readBrowserCapturePublicationJournal("session-1")).resolves.toBeNull();
  });

  test("releases a bound recovery lock after finalize journal failure and retries in process", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = {
      conversationId: "conversation-retry",
      promptEpoch: {
        status: "committed",
        epochId: "epoch-retry",
        promptSha256: "f".repeat(64),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 1,
        verifiedUserTurnId: "turn-retry",
        verifiedUserMessageId: "message-retry",
        conversationId: "conversation-retry",
      },
      recoveryCleanupResources: [
        {
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    let durableRuntime = runtime;
    let lockHeld = true;
    let reacquisitions = 0;
    const releaseLock = vi.fn(async (finalize?: () => Promise<void>) => {
      lockHeld = false;
      await finalize?.();
    });
    let settlement!: ReattachResult;
    const finalizeResources = vi.fn(async () => completedBrowserCaptureCleanup(settlement.runtime));
    settlement = createReattachSettlement(
      { answerText: "answer", answerMarkdown: "answer", finalizeResources },
      runtime,
      null,
      () => undefined,
      {
        runtimeHintCb: async (latestRuntime) => {
          durableRuntime = latestRuntime;
        },
        loadRuntimeUnderLock: async () => durableRuntime,
      },
      {
        ensure: async () => {
          if (lockHeld) return;
          lockHeld = true;
          reacquisitions += 1;
        },
        release: releaseLock,
      },
    );
    const writeFileAtomicDurable = sessionManager.writeFileAtomicDurable;
    let failFinalizeBoundJournal = true;
    vi.spyOn(sessionManager, "writeFileAtomicDurable").mockImplementation(
      async (targetPath, data, mode) => {
        if (
          failFinalizeBoundJournal &&
          path.basename(targetPath) === "browser-capture-publication.json" &&
          String(data).includes('"phase": "finalize-bound"')
        ) {
          failFinalizeBoundJournal = false;
          throw new Error("injected finalize-bound journal failure");
        }
        await writeFileAtomicDurable(targetPath, data, mode);
      },
    );
    const options = {
      answer: { sessionId: "session-1", answer: "answer" },
      transaction: settlement,
      browser: browser(runtime),
      persistAnswer: acceptPreparedReceipt(),
    };

    await expect(publishCompletedBrowserCapture(options)).rejects.toMatchObject({
      details: { code: "finalize-binding-journal-persistence-failed" },
    });
    expect(lockHeld).toBe(false);
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(finalizeResources).not.toHaveBeenCalled();
    await expect(readBrowserCapturePublicationJournal("session-1")).resolves.toMatchObject({
      phase: "staged",
    });

    await expect(publishCompletedBrowserCapture(options)).resolves.toMatchObject({
      published: true,
      finalization: { status: "completed" },
    });
    expect(reacquisitions).toBe(1);
    expect(releaseLock).toHaveBeenCalledTimes(2);
    expect(finalizeResources).toHaveBeenCalledOnce();
  });

  test("keeps FINALIZE journal retryable until terminal session and model projection persist", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const bindSettlement = vi.fn(async () => ({
      ...runtime,
      recoveryCleanupResult: { status: "pending" as const, settlementMode: "finalize" as const },
    }));
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const abort = vi.fn();
    const releaseSettlementLock = vi.fn(async () => undefined);
    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) => {
      if (updates.status === "completed") throw new Error("metadata fsync failed");
      return sessionResult(sessionId, updates);
    });

    const pending = await publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "answer" },
      transaction: { runtime, bindSettlement, releaseSettlementLock, finalize, abort },
      browser: browser(runtime),
      model: "gpt-5.2-pro",
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
      persistAnswer: acceptPreparedReceipt(),
    });
    expect(pending).toMatchObject({
      published: true,
      projection: { status: "pending", error: "metadata fsync failed" },
      finalizationPersistence: { status: "pending" },
    });
    expect(abort).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(releaseSettlementLock).toHaveBeenCalledOnce();
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "finalize-bound",
      model: "gpt-5.2-pro",
    });

    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) =>
      sessionResult(sessionId, updates),
    );
    const recovered = await publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "ignored on recovery" },
      transaction: { runtime, bindSettlement, releaseSettlementLock, finalize, abort },
      browser: browser(runtime),
      persistAnswer: vi.fn(),
      model: "gpt-5.2-pro",
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
    });
    expect(recovered.published).toBe(true);
    expect(recovered.projection).toMatchObject({ status: "persisted" });
    expect(recovered.finalizationPersistence).toMatchObject({ status: "persisted" });
    expect(bindSettlement).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(releaseSettlementLock).toHaveBeenCalledOnce();
  });

  test("recovers when completed session is durable but disk journal remains finalize-bound", async () => {
    await setupSession();
    const runtime: BrowserRuntimeMetadata = { chromeTargetId: "captured" };
    const boundRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const bindSettlement = vi.fn(async () => boundRuntime);
    let currentSession = sessionResult("session-1");
    vi.mocked(sessionStore.readSession).mockImplementation(async () => currentSession);
    vi.mocked(sessionStore.updateSession).mockImplementation(async (_sessionId, updates) => {
      currentSession = {
        ...currentSession,
        ...updates,
        browser: updates.browser ?? currentSession.browser,
      };
      return currentSession;
    });
    const durableWrite = sessionManager.writeFileAtomicDurable;
    let rejectPublishedPhase = true;
    vi.spyOn(sessionManager, "writeFileAtomicDurable").mockImplementation(
      async (targetPath, data, mode) => {
        if (
          rejectPublishedPhase &&
          path.basename(targetPath) === "browser-capture-publication.json" &&
          String(data).includes('"phase": "published"')
        ) {
          rejectPublishedPhase = false;
          throw new Error("crash before published journal replacement");
        }
        await durableWrite(targetPath, data, mode);
      },
    );
    const { promise: finalizeStarted, resolve: markFinalizeStarted } =
      Promise.withResolvers<void>();
    const interrupted = publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "answer" },
      transaction: {
        runtime,
        bindSettlement,
        finalize: vi.fn(() => {
          markFinalizeStarted();
          return new Promise<BrowserCaptureFinalizationResult>(() => undefined);
        }),
        abort: vi.fn(),
      },
      browser: browser(runtime),
      persistAnswer: acceptPreparedReceipt(),
    });
    void interrupted.catch(() => undefined);
    await finalizeStarted;

    await expect(readBrowserCapturePublicationJournal("session-1")).resolves.toMatchObject({
      phase: "finalize-bound",
    });
    expect(currentSession.status).toBe("completed");

    await expect(
      publishCompletedBrowserCapture({
        answer: { sessionId: "session-1", answer: "ignored on recovery" },
        transaction: {
          runtime,
          bindSettlement,
          finalize: vi.fn(async () => ({ status: "completed" as const, runtime: {} })),
          abort: vi.fn(),
        },
        browser: browser(runtime),
        persistAnswer: vi.fn(),
      }),
    ).resolves.toMatchObject({ published: true, finalization: { status: "completed" } });
    expect(bindSettlement).toHaveBeenCalledOnce();
    await expect(readBrowserCapturePublicationJournal("session-1")).resolves.toBeNull();
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
    const releaseSettlementLock = vi.fn(async () => undefined);
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
        transaction: { runtime, bindSettlement, releaseSettlementLock, finalize, abort },
        browser: browser(runtime),
        persistAnswer: acceptPreparedReceipt(),
      }),
    ).rejects.toMatchObject({ details: { code: "finalize-local-binding-persistence-failed" } });
    expect(finalize).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(releaseSettlementLock).toHaveBeenCalledOnce();
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
        transaction: { runtime, bindSettlement, releaseSettlementLock, finalize, abort },
        browser: browser(runtime),
        persistAnswer: vi.fn(),
      }),
    ).resolves.toMatchObject({ published: true, finalization: { status: "completed" } });
    expect(bindSettlement).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(releaseSettlementLock).toHaveBeenCalledOnce();
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
      persistAnswer: acceptPreparedReceipt(),
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
      persistAnswer: acceptPreparedReceipt(),
    });

    expect(result).toMatchObject({
      published: true,
      finalizationPersistence: { status: "pending", error: "metadata fsync failed" },
    });
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "cleanup-pending",
    });
  });

  test("journals terminal cleanup before a failing completed-session projection", async () => {
    await setupSession();
    const targetId = "original-lifecycle-target";
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const logger = vi.fn<(message: string) => void>() as BrowserLogger;
    const capability = retainChromeTargetCloseCapability({
      ownerId: "session-1",
      generationId: "b0000000-0000-4000-8000-00000000000b",
      targetId,
      close: closeTarget,
    });
    const runtime: BrowserRuntimeMetadata = {
      conversationId: "conversation-1",
      recoveryCleanupResources: [
        {
          chromeTargetId: targetId,
          targetCloseCapability: capability,
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
    };
    const transaction = new OwnedBrowserResourceTransaction(
      {
        settleResources: async (_mode, pendingRuntime) => {
          await closeChromeTargetWithRetainedCapability({
            ownerId: "session-1",
            capability,
            targetId,
            logger,
          });
          return completedBrowserCaptureCleanup(pendingRuntime);
        },
      },
      runtime,
    );
    let completedWrites = 0;
    vi.mocked(sessionStore.updateSession).mockImplementation(async (sessionId, updates) => {
      if (updates.status === "completed") {
        completedWrites += 1;
        if (completedWrites > 1) throw new Error("terminal metadata fsync failed");
      }
      return sessionResult(sessionId, updates);
    });

    const result = await publishCompletedBrowserCapture({
      answer: { sessionId: "session-1", answer: "answer" },
      transaction: {
        get runtime() {
          return transaction.runtime();
        },
        bindSettlement: (mode) => transaction.bindSettlement(mode),
        finalize: () => transaction.settle("finalize"),
        abort: () => transaction.settle("abort"),
      },
      browser: browser(runtime),
      persistAnswer: acceptPreparedReceipt(),
    });

    expect(result.finalizationPersistence).toEqual({
      status: "pending",
      error: "terminal metadata fsync failed",
    });
    expect(await readBrowserCapturePublicationJournal("session-1")).toMatchObject({
      phase: "published",
      runtime: { conversationId: "conversation-1" },
    });
    expect(
      (await readBrowserCapturePublicationJournal("session-1"))?.runtime.recoveryCleanupResources,
    ).toBeUndefined();
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      1,
    );
    expect(closeTarget).toHaveBeenCalledOnce();
  });

  test("keeps terminal publication authoritative when journal removal durability is unknown", async () => {
    await setupSession();
    const paths = await sessionStore.getPaths("session-1");
    const artifact = {
      kind: "transcript" as const,
      path: path.join(paths.dir, "artifacts", "browser-answer.md"),
      sha256: "a".repeat(64),
      sizeBytes: 6,
    };
    const runtime: BrowserRuntimeMetadata = { conversationId: "conversation-1" };
    const journal = await installPublicationJournal(
      "published",
      artifact,
      runtime,
      "2026-01-01T00:00:01.000Z",
    );
    vi.spyOn(fsDurability, "syncDirectory").mockRejectedValueOnce(
      new Error("journal directory sync outcome unknown"),
    );

    const result = await persistBrowserCaptureFinalizationState(
      "session-1",
      browser(runtime),
      journal,
      { status: "completed", runtime },
      runtime,
    );

    expect(result).toEqual({ status: "completed", runtime });
    expect(sessionStore.updateSession).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({
        status: "completed",
        browser: expect.objectContaining({ runtime: expect.objectContaining(runtime) }),
      }),
    );
    expect(await readBrowserCapturePublicationJournal("session-1")).toBeNull();
  });

  test("retires paused retained completion after a peer clears the journal", async () => {
    await setupSession();
    const paths = await sessionStore.getPaths("session-1");
    const lockPath = path.join(paths.dir, "browser-recovery.lock");
    const artifact = {
      kind: "transcript" as const,
      path: path.join(paths.dir, "artifacts", "browser-answer-cross-process.md"),
      sha256: "b".repeat(64),
      sizeBytes: 6,
    };
    const pendingRuntime: BrowserRuntimeMetadata = {
      conversationId: "conversation-cross-process",
      recoveryCleanupResources: [
        {
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
      recoveryCleanupResult: {
        status: "pending",
        error: "lock release completion pending",
        settlementMode: "finalize",
        lockReleasePending: true,
      },
    };
    const journal = await installPublicationJournal(
      "cleanup-pending",
      artifact,
      pendingRuntime,
      "2026-01-01T00:00:02.000Z",
    );
    let currentSession = sessionResult("session-1", {
      mode: "browser",
      browser: browser(pendingRuntime),
      artifacts: [artifact],
    });
    vi.mocked(sessionStore.readSession).mockImplementation(async () => currentSession);
    vi.mocked(sessionStore.updateSession).mockImplementation(async (_sessionId, updates) => {
      currentSession = {
        ...currentSession,
        ...updates,
        browser: updates.browser ?? currentSession.browser,
      };
      return currentSession;
    });

    const exactCleanupStarted = Promise.withResolvers<void>();
    const allowExactCleanupToSettle = Promise.withResolvers<void>();
    const controllerA = retainFilesystemLockRelease(
      lockPath,
      {
        pid: process.pid,
        processStartIdentity: "controller-a",
        ownerNonce: "controller-a-release",
      },
      async () => {
        exactCleanupStarted.resolve();
        await allowExactCleanupToSettle.promise;
      },
    );
    let controllerAFinalization: BrowserCaptureFinalizationResult | undefined;
    let controllerARelease: Promise<void> | undefined;
    try {
      controllerARelease = controllerA.release(async () => {
        controllerAFinalization = await persistBrowserCaptureFinalizationState(
          "session-1",
          browser(pendingRuntime),
          journal,
          { status: "completed", runtime: { conversationId: "conversation-cross-process" } },
          pendingRuntime,
        );
      });
      await exactCleanupStarted.promise;

      await persistBrowserCaptureFinalizationState(
        "session-1",
        browser(pendingRuntime),
        journal,
        { status: "completed", runtime: { conversationId: "conversation-cross-process" } },
        pendingRuntime,
      );
      await expect(readBrowserCapturePublicationJournal("session-1")).resolves.toBeNull();
      expect(controllerAFinalization).toBeUndefined();
      expect(hasRetainedFilesystemLockRelease(lockPath)).toBe(true);
      expect(() => lockReleaseJournalTest.clearRetainedFilesystemLockReleases()).toThrow(
        "Cannot clear retained filesystem lock release while cleanup is in flight",
      );
      expect(hasRetainedFilesystemLockRelease(lockPath)).toBe(true);

      allowExactCleanupToSettle.resolve();
      await controllerARelease;
      expect(controllerAFinalization).toEqual({
        status: "completed",
        runtime: expect.objectContaining({ conversationId: "conversation-cross-process" }),
      });
      expect(hasRetainedFilesystemLockRelease(lockPath)).toBe(false);
    } finally {
      allowExactCleanupToSettle.resolve();
      await controllerARelease?.catch(() => undefined);
    }
  });
});
