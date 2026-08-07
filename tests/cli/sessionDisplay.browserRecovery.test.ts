import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  BrowserRuntimeMetadata,
  SessionArtifact,
  SessionMetadata,
} from "../../src/sessionManager.ts";
import { attachSession } from "../../src/cli/sessionDisplay.ts";
import { orchestrateBrowserAttachAuthority } from "../../src/cli/browserAttachController.ts";
import { renderMarkdownAnsi } from "../../src/cli/markdownRenderer.ts";
import {
  BrowserPublicationJournalStore,
  readBrowserCapturePublicationJournal,
  type BrowserCapturePublicationJournal,
  type BrowserPublicationPhase,
} from "../../src/cli/browserPublicationJournal.ts";
import * as browserPublicationJournal from "../../src/cli/browserPublicationJournal.ts";
import chalk from "chalk";
import path from "node:path";
import { BrowserAutomationError } from "../../src/oracle/errors.ts";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "../../src/browser/types.ts";
import {
  settleBrowserRecoveryCleanup as settleBrowserRecoveryCleanupActual,
  type BrowserRecoverySettlementDeps,
} from "../../src/browser/reattachSettlement.ts";
import {
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
} from "../../src/browser/ownedBrowserResources.ts";
import {
  __test__ as targetCloseAuthorityTest,
  acknowledgeChromeTargetCloseCapability,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.ts";
import { createRemoteRecoveryConfigResolver } from "../../src/remote/remoteServiceConfig.ts";
import { createSessionDisplayMetadata } from "./sessionDisplay.fixtures.ts";

const waitMock = vi.hoisted(() => vi.fn());
const resumeBrowserSessionMock = vi.hoisted(() => vi.fn());
const retryBrowserRecoveryCleanupMock = vi.hoisted(() => vi.fn());
const settleBrowserRecoveryCleanupMock = vi.hoisted(() => vi.fn());
const acquireReattachRecoveryLockMock = vi.hoisted(() => vi.fn());
const persistDurableBrowserAnswerMock = vi.hoisted(() => vi.fn());
const saveBrowserTranscriptArtifactMock = vi.hoisted(() => vi.fn());
const saveDeepResearchReportArtifactMock = vi.hoisted(() => vi.fn());
const writeFileAtomicDurableMock = vi.hoisted(() => vi.fn());
const commitSessionModelProjectionMock = vi.hoisted(() => vi.fn());
const sessionStoreMock = vi.hoisted(() => ({
  readSession: vi.fn(),
  readLog: vi.fn(),
  readModelLog: vi.fn(),
  readRequest: vi.fn(),
  updateSession: vi.fn(),
  updateModelRun: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  getPaths: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
  commitSessionModelProjection: commitSessionModelProjectionMock,
  wait: waitMock,
}));

vi.mock("../../src/sessionManager.ts", () => ({
  wait: vi.fn(),
  writeFileAtomicDurable: writeFileAtomicDurableMock,
}));
vi.mock("../../src/browser/reattach.ts", async () => {
  // A partial mock must retain the production recovery helpers used by these cases.
  const actual = await vi.importActual<Record<string, unknown>>("../../src/browser/reattach.ts");
  return {
    ...actual,
    resumeBrowserSession: resumeBrowserSessionMock,
    retryBrowserRecoveryCleanup: retryBrowserRecoveryCleanupMock,
    settleBrowserRecoveryCleanup: settleBrowserRecoveryCleanupMock,
  };
});
vi.mock("../../src/browser/reattachLock.ts", () => ({
  acquireReattachRecoveryLock: acquireReattachRecoveryLockMock,
}));

vi.mock("../../src/cli/durableAnswer.ts", async () => {
  // A partial mock must retain publication helpers outside durable-answer persistence.
  const actual = await vi.importActual<Record<string, unknown>>("../../src/cli/durableAnswer.ts");
  return {
    ...actual,
    persistDurableBrowserAnswer: persistDurableBrowserAnswerMock,
  };
});

vi.mock("../../src/browser/artifacts.ts", async () => {
  // A partial mock must retain artifact behavior outside the captured answer writers.
  const actual = await vi.importActual<Record<string, unknown>>("../../src/browser/artifacts.ts");
  return {
    ...actual,
    saveBrowserTranscriptArtifact: saveBrowserTranscriptArtifactMock,
    saveDeepResearchReportArtifact: saveDeepResearchReportArtifactMock,
  };
});

vi.mock("../../src/cli/markdownRenderer.ts", () => {
  return {
    renderMarkdownAnsi: vi.fn((s: string) => `RENDER:${s}`),
  };
});

const renderMarkdownMock = renderMarkdownAnsi as unknown as { mockClear?: () => void };
const readSessionMetadataMock = sessionStoreMock.readSession;
const readSessionLogMock = sessionStoreMock.readLog;
const readSessionRequestMock = sessionStoreMock.readRequest;

const originalIsTty = process.stdout.isTTY;
const tempDirectories: string[] = [];

async function installBrowserPublicationJournal(
  phase: BrowserPublicationPhase,
  runtime: BrowserRuntimeMetadata,
  answer: string,
  model?: string,
): Promise<BrowserCapturePublicationJournal> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-display-publication-"));
  tempDirectories.push(directory);
  const artifactsDirectory = path.join(directory, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true });
  const sha256 = createHash("sha256").update(answer).digest("hex");
  const artifact: SessionArtifact = {
    kind: "transcript",
    path: path.join(artifactsDirectory, `browser-answer-${sha256}.md`),
    label: "Durable browser answer",
    mimeType: "text/markdown",
    sha256,
    sizeBytes: Buffer.byteLength(answer),
    validation: { type: "generic", ok: true },
    transfer: { status: "not-needed" },
    origin: { mode: "local" },
  };
  await writeFile(artifact.path, answer);
  sessionStoreMock.getPaths.mockResolvedValue({
    dir: directory,
    log: path.join(directory, "session.log"),
  });
  writeFileAtomicDurableMock.mockImplementationOnce(
    async (targetPath: string, payload: string | Uint8Array) => {
      await writeFile(targetPath, payload);
    },
  );
  const store = new BrowserPublicationJournalStore("sess");
  const preparing = store.reduce(null, {
    type: "prepare",
    journal: {
      sessionId: "sess",
      receipt: { artifact },
      artifacts: [],
      completedAt: "2026-08-05T00:00:00.000Z",
      response: { status: "completed" },
      browserAudit: { runtime },
      runtime,
      ...(model ? { model } : {}),
    },
  });
  if (phase === "preparing") {
    return store.transition(null, {
      type: "prepare",
      journal: {
        sessionId: "sess",
        receipt: { artifact },
        artifacts: [],
        completedAt: "2026-08-05T00:00:00.000Z",
        response: { status: "completed" },
        browserAudit: { runtime },
        runtime,
        ...(model ? { model } : {}),
      },
    });
  }
  const staged = store.reduce(preparing, {
    type: "answer-staged",
    receipt: { artifact },
    artifacts: [artifact],
  });
  if (phase === "staged") {
    return store.transition(preparing, {
      type: "answer-staged",
      receipt: { artifact },
      artifacts: [artifact],
    });
  }
  const finalizeBound = store.reduce(staged, {
    type: "finalize-bound",
    receipt: { artifact },
    settlementMode: "finalize",
    runtime,
    browserAudit: { runtime },
  });
  if (phase === "finalize-bound") {
    return store.transition(staged, {
      type: "finalize-bound",
      receipt: { artifact },
      settlementMode: "finalize",
      runtime,
      browserAudit: { runtime },
    });
  }
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
const originalChalkLevel = chalk.level;

function committedPromptAuthority(conversationId: string): BrowserRuntimeMetadata {
  return {
    conversationId,
    promptEpoch: {
      status: "committed",
      epochId: `epoch-${conversationId}`,
      promptSha256: "e".repeat(64),
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps: 0,
      verifiedUserTurnIndex: 1,
      verifiedUserTurnId: "turn-1",
      verifiedUserMessageId: "message-1",
      conversationId,
    },
  };
}

function committedGeminiRecoveryAuthority(): BrowserRuntimeMetadata {
  const targetId = "gemini-target-1";
  const generationId = "gemini-generation-1";
  const promptEpoch = {
    status: "committed" as const,
    epochId: "gemini-epoch-1",
    promptSha256: "d".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "data-message-id:gemini-user-current",
    verifiedUserMessageId: "data-message-id:gemini-user-current",
    conversationId: targetId,
  };
  return {
    chromeHost: "127.0.0.1",
    chromePort: 9222,
    chromeTargetId: targetId,
    tabUrl: `about:blank#oracle-acquisition=${generationId}`,
    conversationId: targetId,
    promptEpoch,
    recoveryCleanupResources: [
      {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: targetId,
        conversationId: targetId,
        promptEpoch,
        targetCloseCapability: {
          version: 1,
          generationId,
          capabilityId: "gemini-target-capability-1",
          targetId,
        },
        tabLease: {
          id: "gemini-tab-lease-1",
          generationId,
          profileDirectory: {
            version: 2,
            platform: process.platform,
            canonicalPath: "/tmp/oracle-gemini-profile",
            device: "1",
            inode: "2",
            birthtimeNs: "3",
          },
        },
        acquisition: {
          generationId,
          targetMarkerUrl: `about:blank#oracle-acquisition=${generationId}`,
        },
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "manual-login",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      },
    ],
    recoveryCleanupResult: { status: "pending" },
  };
}

function pendingChromeProcessAcquisitionRuntime(): BrowserRuntimeMetadata {
  const userDataDir = path.resolve("/tmp/oracle-display-acquisition");
  const generationId = "70000000-0000-4000-8000-000000000007";
  return {
    browserTransport: "cdp",
    chromePid: 7_777,
    chromeHost: "127.0.0.1",
    chromeProfileRoot: userDataDir,
    userDataDir,
    recoveryCleanupResources: [
      {
        chromePid: 7_777,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: userDataDir,
        userDataDir,
        profileDirectoryIdentity: {
          version: 2,
          platform: process.platform,
          canonicalPath: userDataDir,
          device: "1",
          inode: "2",
          birthtimeNs: "3",
        },
        acquisition: {
          generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: {
            version: 1,
            generationId,
            nonce: "80000000-0000-4000-8000-000000000008",
          },
          processOwnerDisposition: "close-on-last-lease",
        },

        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      },
    ],
    recoveryCleanupResult: { status: "pending" },
  };
}

function mockRecoveredCleanupResult(
  result: BrowserCaptureFinalizationResult,
  observePublicationAcknowledgement?: (acknowledged: boolean) => void,
): void {
  retryBrowserRecoveryCleanupMock.mockImplementation(async (_runtime, _logger, deps) => {
    observePublicationAcknowledgement?.(Boolean(deps.isRemotePublicationAcknowledged?.()));
    return result;
  });
}

beforeEach(() => {
  vi.useRealTimers();
  process.exitCode = undefined;
  waitMock.mockClear();
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  chalk.level = 1;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  Object.values(sessionStoreMock).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) {
      fn.mockReset();
    }
  });
  commitSessionModelProjectionMock.mockReset();
  for (const mock of [
    resumeBrowserSessionMock,
    retryBrowserRecoveryCleanupMock,
    settleBrowserRecoveryCleanupMock,
    acquireReattachRecoveryLockMock,
    persistDurableBrowserAnswerMock,
    saveBrowserTranscriptArtifactMock,
    saveDeepResearchReportArtifactMock,
    writeFileAtomicDurableMock,
  ]) {
    mock.mockReset();
  }
  acquireReattachRecoveryLockMock.mockImplementation(async () => ({
    release: async (complete?: () => Promise<void>) => complete?.(),
  }));
  writeFileAtomicDurableMock.mockResolvedValue(undefined);
  sessionStoreMock.sessionsDir.mockReturnValue("/tmp/sessions");
  sessionStoreMock.getPaths.mockResolvedValue({
    dir: "/tmp/sessions/sess",
    log: "/tmp/sessions/sess/session.log",
  });
  persistDurableBrowserAnswerMock.mockImplementation(async (_options, expectedReceipt) => {
    if (!expectedReceipt) throw new Error("publication intent receipt missing");
    return expectedReceipt;
  });
  commitSessionModelProjectionMock.mockImplementation(async (sessionId, projection) => {
    const updated = await sessionStoreMock.updateSession(sessionId, projection.session);
    const baseSession = {
      id: sessionId,
      createdAt: "2026-08-05T00:00:00.000Z",
      status: "running" as const,
      options: {},
      ...(updated ?? {}),
      ...projection.session,
    };
    if (!projection.model) return { session: baseSession };
    const modelRun = {
      model: projection.model.model,
      status: projection.model.updates.status ?? "pending",
      ...projection.model.updates,
    };
    await sessionStoreMock.updateModelRun(
      sessionId,
      projection.model.model,
      projection.model.updates,
    );
    return {
      session: {
        ...baseSession,
        models: [modelRun],
        modelProjectionAuthority: "session",
      },
      model: modelRun,
    };
  });
  settleBrowserRecoveryCleanupMock.mockImplementation(
    async (
      runtime: BrowserRuntimeMetadata,
      logger: BrowserLogger,
      deps: BrowserRecoverySettlementDeps,
      mode?: "finalize" | "abort",
    ) => {
      const cleanupFinalization = (await retryBrowserRecoveryCleanupMock(
        runtime,
        logger,
        deps,
        mode,
      )) as BrowserCaptureFinalizationResult;
      let finalization = cleanupFinalization;
      let durableRuntime = runtime;
      const settlementMode = mode ?? runtime.recoveryCleanupResult?.settlementMode ?? "finalize";
      try {
        if (finalization.status === "completed" && deps.persistFinalizationResult) {
          const underLock = await deps.persistFinalizationResult(
            {
              status: "pending",
              runtime: {
                ...finalization.runtime,
                ...(runtime.recoveryCleanupResources?.length
                  ? { recoveryCleanupResources: runtime.recoveryCleanupResources }
                  : {}),
                recoveryCleanupResult: {
                  status: "pending",
                  error: "Browser cleanup completed, but recovery lock release remains pending",
                  settlementMode,
                  lockReleasePending: true,
                },
              },
              error: "Browser cleanup completed, but recovery lock release remains pending",
            },
            runtime,
            settlementMode,
          );
          durableRuntime = underLock.runtime;
          if (deps.completeFinalizationAfterLockRelease) {
            finalization = await deps.completeFinalizationAfterLockRelease(
              finalization,
              runtime,
              settlementMode,
            );
          }
        } else if (deps.persistFinalizationResult) {
          finalization = await deps.persistFinalizationResult(
            finalization,
            runtime,
            settlementMode,
          );
          durableRuntime = finalization.runtime;
        }
        return { finalization, persistence: { status: "persisted" as const } };
      } catch (error) {
        return {
          finalization: cleanupFinalization,
          persistence: {
            status: "pending" as const,
            error: error instanceof Error ? error.message : String(error),
            runtime: durableRuntime,
          },
        };
      }
    },
  );
  saveBrowserTranscriptArtifactMock.mockResolvedValue(null);
  saveDeepResearchReportArtifactMock.mockResolvedValue(null);
});

afterEach(async () => {
  vi.useRealTimers();
  process.exitCode = undefined;
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
  chalk.level = originalChalkLevel;
  vi.restoreAllMocks();
  targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser recovery and publication rendering", () => {
  const baseMeta: SessionMetadata = createSessionDisplayMetadata();

  beforeEach(() => {
    renderMarkdownMock?.mockClear?.();
    readSessionRequestMock.mockReset();
  });

  test("retries completed cleanup after a durable receipt without restoring status", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "bridge.example:9443",
      transactionToken: "a".repeat(64),
      state: "pending" as const,
    };
    const pendingRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "completed-pending-target",
          remoteRecovery,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const completedMeta: SessionMetadata = {
      ...baseMeta,
      mode: "browser",
      artifacts: [
        {
          kind: "transcript",
          path: "/tmp/sessions/sess/artifacts/durable-browser-answer.md",
          label: "Durable browser answer",
          sha256: "a".repeat(64),
          sizeBytes: 16,
        },
      ],
      browser: { runtime: pendingRuntime },
    };
    const settledRuntime: BrowserRuntimeMetadata = {};
    retryBrowserRecoveryCleanupMock.mockResolvedValue({
      status: "completed",
      runtime: settledRuntime,
    });
    readSessionMetadataMock
      .mockResolvedValueOnce(completedMeta)
      .mockResolvedValue({ ...completedMeta, browser: { runtime: settledRuntime } });
    readSessionLogMock.mockResolvedValue("");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.objectContaining({
        recoveryLockPath: expect.stringMatching(/browser-recovery-[0-9a-f]{24}\.lock$/u),
        recoveryCleanup: {
          retainChromeEndpointAuthority: expect.any(Function),
        },
        isRemotePublicationAcknowledged: expect.any(Function),
      }),
      "finalize",
    );
    expect(
      retryBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
    ).toBe(true);
    expect(sessionStoreMock.updateSession).toHaveBeenCalledWith("sess", {
      browser: { runtime: settledRuntime },
    });
    expect(
      sessionStoreMock.updateSession.mock.calls.every(([, patch]) => patch.status === undefined),
    ).toBe(true);
    expect(sessionStoreMock.updateModelRun).not.toHaveBeenCalled();
  });

  test("publishes a verified preparing answer without live browser authority", async () => {
    const answer = "answer already durable before restart";
    const runtime: BrowserRuntimeMetadata = {
      chromePid: 2_147_483_647,
      recoveryCleanupResources: [
        {
          chromePid: 2_147_483_647,
          chromeTargetId: "gone-target",
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const journal = await installBrowserPublicationJournal("preparing", runtime, answer);
    const completedMeta: SessionMetadata = {
      ...baseMeta,
      mode: "browser",
      browser: { config: {} },
    };
    const recoveredMeta = { ...completedMeta, artifacts: [journal.receipt.artifact] };
    readSessionMetadataMock.mockResolvedValue(recoveredMeta);
    let publicationAcknowledgedDuringCleanup = false;
    mockRecoveredCleanupResult({ status: "completed", runtime: {} }, (acknowledged) => {
      publicationAcknowledgedDuringCleanup = acknowledged;
    });
    resumeBrowserSessionMock.mockRejectedValue(new Error("browser authority is unavailable"));
    writeFileAtomicDurableMock.mockImplementation(
      async (targetPath: string, payload: string | Uint8Array) => {
        await writeFile(targetPath, payload);
      },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orchestrateBrowserAttachAuthority("sess", completedMeta);

    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(persistDurableBrowserAnswerMock).not.toHaveBeenCalled();
    expect(acquireReattachRecoveryLockMock).toHaveBeenCalled();
    expect(settleBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryCleanupResult: expect.objectContaining({ settlementMode: "finalize" }),
      }),
      expect.any(Function),
      expect.objectContaining({
        acquireRecoveryLock: expect.any(Function),
        loadRuntimeUnderLock: expect.any(Function),
        persistFinalizationResult: expect.any(Function),
        completeFinalizationAfterLockRelease: expect.any(Function),
        isRemotePublicationAcknowledged: expect.any(Function),
      }),
      "finalize",
    );
    expect(publicationAcknowledgedDuringCleanup).toBe(true);
    expect(
      settleBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
    ).toBe(false);
  });

  test("retries cleanup-pending publication authority without recapturing the answer", async () => {
    const answer = "published answer awaiting cleanup";
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          chromeTargetId: "retained-target",
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "cleanup interrupted",
        settlementMode: "finalize",
      },
    };
    const journal = await installBrowserPublicationJournal("cleanup-pending", runtime, answer);
    const completedMeta: SessionMetadata = {
      ...baseMeta,
      mode: "browser",
      browser: { config: {} },
      artifacts: [journal.receipt.artifact],
    };
    readSessionMetadataMock.mockResolvedValue(completedMeta);
    let publicationAcknowledgedDuringCleanup = false;
    mockRecoveredCleanupResult({ status: "completed", runtime: {} }, (acknowledged) => {
      publicationAcknowledgedDuringCleanup = acknowledged;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orchestrateBrowserAttachAuthority("sess", completedMeta);

    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(persistDurableBrowserAnswerMock).not.toHaveBeenCalled();
    expect(saveBrowserTranscriptArtifactMock).not.toHaveBeenCalled();
    expect(saveDeepResearchReportArtifactMock).not.toHaveBeenCalled();
    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryCleanupResult: expect.objectContaining({ settlementMode: "finalize" }),
      }),
      expect.any(Function),
      expect.objectContaining({ isRemotePublicationAcknowledged: expect.any(Function) }),
      "finalize",
    );
    expect(publicationAcknowledgedDuringCleanup).toBe(true);
    expect(
      retryBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
    ).toBe(false);
  });

  test("replays a durably journaled close after final session persistence fails and tombstones churn", async () => {
    const answer = "published answer with completed target cleanup";
    const targetId = "recovered-owned-target";
    const generationId = "90000000-0000-4000-8000-000000000009";
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const logger = vi.fn<(message: string) => void>();
    const targetCloseCapability = retainChromeTargetCloseCapability({
      ownerId: "sess",
      generationId,
      targetId,
      close: closeTarget,
    });
    const runtime: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
      recoveryCleanupResources: [
        {
          chromeTargetId: targetId,
          targetCloseCapability,
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const journal = await installBrowserPublicationJournal("published", runtime, answer);
    const completedMeta: SessionMetadata = {
      ...baseMeta,
      mode: "browser",
      browser: { config: {}, runtime },
      artifacts: [journal.receipt.artifact],
    };
    writeFileAtomicDurableMock.mockImplementation(
      async (targetPath: string, payload: string | Uint8Array) => {
        await writeFile(targetPath, payload);
      },
    );
    let terminalProjectionAttempts = 0;
    sessionStoreMock.updateSession.mockImplementation(async (_sessionId, patch) => {
      if (patch.status === "completed" && !patch.browser?.runtime?.recoveryCleanupResult) {
        terminalProjectionAttempts += 1;
        if (terminalProjectionAttempts <= 2) {
          throw new Error(
            terminalProjectionAttempts === 1
              ? "final session store unavailable"
              : "final session store still unavailable",
          );
        }
      }
    });
    readSessionMetadataMock.mockResolvedValue(completedMeta);
    retryBrowserRecoveryCleanupMock.mockImplementation(
      async (pendingRuntime: BrowserRuntimeMetadata) => {
        const resource = pendingRuntime.recoveryCleanupResources?.[0];
        if (!resource?.chromeTargetId || !resource.targetCloseCapability) {
          return completedBrowserCaptureCleanup(pendingRuntime);
        }
        const closeResult = await closeChromeTargetWithRetainedCapability({
          ownerId: "sess",
          capability: resource.targetCloseCapability,
          targetId: resource.chromeTargetId,
          logger,
        });
        return closeResult.status === "completed" || closeResult.status === "gone"
          ? completedBrowserCaptureCleanup(pendingRuntime)
          : pendingBrowserCaptureCleanup(pendingRuntime, closeResult.reason, "finalize");
      },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orchestrateBrowserAttachAuthority("sess", completedMeta);

    const persistedSettlement = await readBrowserCapturePublicationJournal("sess");
    expect(persistedSettlement).toMatchObject({
      phase: "published",
      runtime: { browserTransport: "cdp" },
    });
    expect(persistedSettlement?.runtime.recoveryCleanupResources).toBeUndefined();
    expect(terminalProjectionAttempts).toBe(2);
    expect(closeTarget).toHaveBeenCalledOnce();

    const churnCount = targetCloseAuthorityTest.retainedTerminalTargetCloseCapabilityLimit + 1;
    for (let index = 0; index < churnCount; index += 1) {
      const churnTargetId = `churn-target-${index}`;
      const churnCapability = retainChromeTargetCloseCapability({
        ownerId: "test-owner",
        generationId: `churn-generation-${index}`,
        targetId: churnTargetId,
        close: async () => ({ status: "completed" as const }),
      });
      await closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability: churnCapability,
        targetId: churnTargetId,
        logger,
      });
      acknowledgeChromeTargetCloseCapability({
        ownerId: "test-owner",
        capability: churnCapability,
        targetId: churnTargetId,
      });
    }
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "sess",
        capability: targetCloseCapability,
        targetId,
        logger,
      }),
    ).resolves.toMatchObject({ status: "completed" });

    await orchestrateBrowserAttachAuthority("sess", completedMeta);

    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledTimes(2);
    expect(
      retryBrowserRecoveryCleanupMock.mock.calls[1]?.[0]?.recoveryCleanupResources,
    ).toBeUndefined();
    expect(closeTarget).toHaveBeenCalledOnce();
    await expect(readBrowserCapturePublicationJournal("sess")).resolves.toBeNull();
  });

  test("retires a matching pre-cleanup journal when completed metadata proves terminal after restart", async () => {
    const answer = "published answer whose terminal projection survived restart";
    const targetId = "stale-journal-target";
    const targetCloseCapability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId: "a0000000-0000-4000-8000-00000000000a",
      targetId,
      close: vi.fn(async () => ({ status: "completed" as const })),
    });
    const staleRuntime: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
      recoveryCleanupResources: [
        {
          chromeTargetId: targetId,
          targetCloseCapability,
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const journal = await installBrowserPublicationJournal("published", staleRuntime, answer);
    const completedMeta: SessionMetadata = {
      ...baseMeta,
      status: "completed",
      completedAt: journal.completedAt,
      mode: "browser",
      artifacts: [journal.receipt.artifact],
      browser: { config: {}, runtime: { browserTransport: "cdp" } },
    };
    readSessionMetadataMock.mockResolvedValue(completedMeta);
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orchestrateBrowserAttachAuthority("sess", completedMeta);

    await expect(readBrowserCapturePublicationJournal("sess")).resolves.toBeNull();
    expect(retryBrowserRecoveryCleanupMock).not.toHaveBeenCalled();
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession).not.toHaveBeenCalled();
  });

  test("does not retire a published journal while selected-model projection is missing", async () => {
    const answer = "published answer awaiting selected-model repair";
    const runtime: BrowserRuntimeMetadata = { browserTransport: "cdp" };
    const journal = await installBrowserPublicationJournal(
      "published",
      runtime,
      answer,
      "gpt-5.2-pro",
    );
    const splitMetadata: SessionMetadata = {
      ...baseMeta,
      status: "completed",
      completedAt: journal.completedAt,
      mode: "browser",
      model: "gpt-5.2-pro",
      artifacts: [journal.receipt.artifact],
      browser: { config: {}, runtime },
      models: [{ model: "gpt-5.2-pro", status: "running" }],
      modelProjectionAuthority: "session",
    };
    readSessionMetadataMock.mockResolvedValue(splitMetadata);
    commitSessionModelProjectionMock.mockRejectedValue(new Error("projection store unavailable"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orchestrateBrowserAttachAuthority("sess", splitMetadata);

    await expect(readBrowserCapturePublicationJournal("sess")).resolves.toMatchObject({
      phase: "published",
      model: "gpt-5.2-pro",
    });
    expect(commitSessionModelProjectionMock).toHaveBeenCalledTimes(2);
    expect(retryBrowserRecoveryCleanupMock).not.toHaveBeenCalled();
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("repairs selected-model projection before retiring a recovered journal", async () => {
    const answer = "published answer repaired on restart";
    const runtime: BrowserRuntimeMetadata = { browserTransport: "cdp" };
    const journal = await installBrowserPublicationJournal(
      "published",
      runtime,
      answer,
      "gpt-5.2-pro",
    );
    const splitMetadata: SessionMetadata = {
      ...baseMeta,
      status: "completed",
      completedAt: journal.completedAt,
      mode: "browser",
      model: "gpt-5.2-pro",
      artifacts: [journal.receipt.artifact],
      browser: { config: {}, runtime },
      models: [{ model: "gpt-5.2-pro", status: "running" }],
      modelProjectionAuthority: "session",
    };
    readSessionMetadataMock.mockResolvedValue(splitMetadata);
    mockRecoveredCleanupResult({ status: "completed", runtime });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orchestrateBrowserAttachAuthority("sess", splitMetadata);

    expect(commitSessionModelProjectionMock).toHaveBeenCalledWith(
      "sess",
      expect.objectContaining({
        session: expect.objectContaining({ status: "completed" }),
        model: expect.objectContaining({
          model: "gpt-5.2-pro",
          updates: expect.objectContaining({ status: "completed" }),
        }),
      }),
    );
    await expect(readBrowserCapturePublicationJournal("sess")).resolves.toBeNull();
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("defers journal recovery while the live publisher commits and finalizes cleanup", async () => {
    const answer = "answer still being finalized by the live worker";
    const liveRuntime: BrowserRuntimeMetadata = {
      controllerPid: process.pid,
      recoveryCleanupResources: [
        {
          chromeTargetId: "live-publisher-target",
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const journal = await installBrowserPublicationJournal("published", liveRuntime, answer);
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: "oracle session sess",
      },
      browser: { runtime: liveRuntime },
    };
    readSessionMetadataMock.mockResolvedValue(runningMeta);

    await orchestrateBrowserAttachAuthority("sess", runningMeta);

    expect(settleBrowserRecoveryCleanupMock).not.toHaveBeenCalled();
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    await expect(readBrowserCapturePublicationJournal("sess")).resolves.toMatchObject({
      runtime: { recoveryCleanupResult: { status: "pending" } },
    });

    const committedPreCleanupMeta: SessionMetadata = {
      ...runningMeta,
      status: "completed",
      artifacts: [journal.receipt.artifact],
      completedAt: journal.completedAt,
    };
    readSessionMetadataMock.mockResolvedValue(committedPreCleanupMeta);
    await orchestrateBrowserAttachAuthority("sess", committedPreCleanupMeta);

    expect(settleBrowserRecoveryCleanupMock).not.toHaveBeenCalled();
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession).not.toHaveBeenCalled();
    await expect(readBrowserCapturePublicationJournal("sess")).resolves.toMatchObject({
      phase: "published",
      runtime: { recoveryCleanupResult: { status: "pending" } },
    });

    const completedMeta: SessionMetadata = {
      ...runningMeta,
      status: "completed",
      completedAt: journal.completedAt,
      artifacts: [journal.receipt.artifact],
      browser: { runtime: {} },
    };
    readSessionMetadataMock.mockResolvedValue(completedMeta);
    await orchestrateBrowserAttachAuthority("sess", completedMeta);

    await expect(readBrowserCapturePublicationJournal("sess")).resolves.toBeNull();
    expect(settleBrowserRecoveryCleanupMock).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession).not.toHaveBeenCalled();
  });

  test("discards a stale preparing journal when persisted ABORT authority has no receipt", async () => {
    const answer = "answer from an abandoned preparing transaction";
    const preAbortRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          chromeTargetId: "aborted-target",
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    await installBrowserPublicationJournal("preparing", preAbortRuntime, answer);
    const abortRuntime: BrowserRuntimeMetadata = {
      ...preAbortRuntime,
      recoveryCleanupResult: {
        status: "failed",
        error: "abort cleanup interrupted",
        settlementMode: "abort",
      },
    };
    const completedMeta: SessionMetadata = {
      ...baseMeta,
      mode: "browser",
      browser: { runtime: abortRuntime },
    };
    readSessionMetadataMock.mockResolvedValue({
      ...completedMeta,
      browser: { runtime: {} },
    });
    retryBrowserRecoveryCleanupMock.mockResolvedValue({ status: "completed", runtime: {} });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orchestrateBrowserAttachAuthority("sess", completedMeta);

    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(persistDurableBrowserAnswerMock).not.toHaveBeenCalled();
    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      abortRuntime,
      expect.any(Function),
      expect.objectContaining({ isRemotePublicationAcknowledged: expect.any(Function) }),
      "abort",
    );
    expect(
      retryBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
    ).toBe(false);
    expect(await readBrowserCapturePublicationJournal("sess")).toBeNull();
  });

  test("does not settle completed browser cleanup without a durable answer receipt", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "unpublished-target",
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    readSessionMetadataMock.mockResolvedValue({
      ...baseMeta,
      mode: "browser",
      browser: { runtime: pendingRuntime },
    });
    readSessionLogMock.mockResolvedValue("");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    expect(retryBrowserRecoveryCleanupMock).not.toHaveBeenCalled();
  });

  test("aborts exact epoch-less acquisition cleanup for a stale running session", async () => {
    const pendingRuntime = pendingChromeProcessAcquisitionRuntime();
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      browser: { config: {}, runtime: pendingRuntime },
    };
    const recoveredMeta: SessionMetadata = {
      ...runningMeta,
      status: "error",
      browser: { config: {}, runtime: {} },
      errorMessage:
        "Browser session stopped before committing a prompt; acquisition cleanup completed.",
    };
    retryBrowserRecoveryCleanupMock.mockResolvedValueOnce({ status: "completed", runtime: {} });
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValue(recoveredMeta);
    readSessionLogMock.mockResolvedValue("");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.objectContaining({
        recoveryLockPath: expect.stringMatching(/browser-recovery-[0-9a-f]{24}\.lock$/u),
      }),
      "abort",
    );
    expect(sessionStoreMock.updateSession).toHaveBeenCalledWith(
      "sess",
      expect.objectContaining({
        status: "error",
        browser: { config: {}, runtime: {} },
        error: expect.objectContaining({
          category: "browser-automation",
          details: expect.objectContaining({
            stage: "browser-acquisition-recovery",
            code: "browser-acquisition-cleanup-completed",
          }),
        }),
      }),
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("retries explicit abort authority for a completed recovery attempt", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = {
      chromePid: 123,
      chromePort: 9222,
      userDataDir: "/tmp/recovery-profile",
      recoveryCleanupResources: [
        {
          chromePid: 123,
          chromePort: 9222,
          userDataDir: "/tmp/recovery-profile",
          chromeTargetId: "recovery-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: true,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "recovery capture failed after target acquisition",
        settlementMode: "abort",
      },
    };
    const completedMeta: SessionMetadata = {
      ...baseMeta,
      status: "completed",
      mode: "browser",
      browser: { runtime: pendingRuntime },
    };
    retryBrowserRecoveryCleanupMock.mockResolvedValue({ status: "completed", runtime: {} });
    readSessionMetadataMock
      .mockResolvedValueOnce(completedMeta)
      .mockResolvedValue({ ...completedMeta, browser: { runtime: {} } });
    readSessionLogMock.mockResolvedValue("");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.objectContaining({
        recoveryLockPath: expect.stringMatching(/browser-recovery-[0-9a-f]{24}\.lock$/u),
      }),
      "abort",
    );
    expect(
      retryBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
    ).toBe(false);
  });

  test("retries persisted abort authority for an error session", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "bridge.example:9443",
      transactionToken: "b".repeat(64),
      state: "pending" as const,
    };
    const remoteToken = "d".repeat(64);
    const resolveRemoteRecoveryConfig = vi.fn(async () => ({
      host: remoteRecovery.host,
      token: remoteToken,
    }));
    const pendingRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "abort retry",
        settlementMode: "abort",
      },
    };
    const errorMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      browser: { runtime: pendingRuntime },
    };
    retryBrowserRecoveryCleanupMock.mockResolvedValue({ status: "completed", runtime: {} });
    readSessionMetadataMock
      .mockResolvedValueOnce(errorMeta)
      .mockResolvedValue({ ...errorMeta, browser: { runtime: {} } });
    readSessionLogMock.mockResolvedValue("");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
      resolveRemoteRecoveryConfig,
    });

    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.objectContaining({
        recoveryLockPath: expect.stringMatching(/browser-recovery-[0-9a-f]{24}\.lock$/u),
        recoveryCleanup: expect.objectContaining({ resolveRemoteRecoveryConfig }),
      }),
      "abort",
    );
    expect(
      retryBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
    ).toBe(false);
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(JSON.stringify(sessionStoreMock.updateSession.mock.calls)).not.toContain(remoteToken);
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain(remoteToken);
  });

  test("reattaches executor-style committed Gemini authority from an acquisition marker", async () => {
    const runtime = committedGeminiRecoveryAuthority();
    const errorMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      browser: {
        config: { desiredModel: "gemini-3-pro-deep-think", timeoutMs: 2_000 },
        runtime,
      },
      response: { status: "error", incompleteReason: "incomplete-capture" },
      error: {
        category: "browser-automation",
        message: "Gemini response capture remains pending",
        details: {
          stage: "gemini-response-capture",
          code: "gemini-response-capture-recoverable",
          reattachable: true,
          runtime,
        },
      },
    };
    resumeBrowserSessionMock.mockRejectedValueOnce(
      new BrowserAutomationError("Gemini answer is still generating", {
        stage: "gemini-response-capture",
        code: "gemini-reattach-capture-pending",
        reattachable: true,
        runtime,
      }),
    );
    sessionStoreMock.updateSession.mockResolvedValue(errorMeta);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const recovered = await orchestrateBrowserAttachAuthority("sess", errorMeta);

    expect(resumeBrowserSessionMock).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ desiredModel: "gemini-3-pro-deep-think" }),
      expect.any(Function),
      expect.objectContaining({ sessionId: "sess" }),
    );
    expect(retryBrowserRecoveryCleanupMock).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession).toHaveBeenCalledWith("sess", {
      browser: { ...errorMeta.browser, runtime },
    });
    expect(recovered).toBe(errorMeta);
  });

  test("aborts owned Gemini resources when immutable response identity is unavailable", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeTargetId: "gemini-synthetic-target",
      conversationId: "gemini-synthetic-target",
      promptEpoch: {
        status: "committed",
        epochId: "gemini-synthetic-epoch",
        promptSha256: "f".repeat(64),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "gemini-dom-turn:0:synthetic",
        verifiedUserMessageId: "gemini-dom-turn:0:synthetic",
        conversationId: "gemini-synthetic-target",
      },
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "gemini-synthetic-target",
          conversationId: "gemini-synthetic-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const settledRuntime: BrowserRuntimeMetadata = {
      conversationId: pendingRuntime.conversationId,
      promptEpoch: pendingRuntime.promptEpoch,
    };
    const errorMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      browser: {
        config: { desiredModel: "gemini-3-pro-deep-think" },
        runtime: pendingRuntime,
      },
      response: { status: "error", incompleteReason: "incomplete-capture" },
      error: {
        category: "browser-automation",
        message: "Gemini response identity is unavailable after commit",
        details: {
          stage: "gemini-response-capture",
          code: "gemini-reattach-authority-unavailable",
          reattachable: false,
        },
      },
    };
    const settledMeta: SessionMetadata = {
      ...errorMeta,
      browser: { ...errorMeta.browser, runtime: settledRuntime },
    };
    retryBrowserRecoveryCleanupMock.mockResolvedValue({
      status: "completed",
      runtime: settledRuntime,
    });
    readSessionMetadataMock.mockResolvedValue(settledMeta);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const recovered = await orchestrateBrowserAttachAuthority("sess", errorMeta);

    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.objectContaining({
        recoveryLockPath: expect.stringMatching(/browser-recovery-[0-9a-f]{24}\.lock$/u),
      }),
      "abort",
    );
    expect(
      retryBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
    ).toBe(false);
    expect(sessionStoreMock.updateSession).toHaveBeenCalledWith("sess", {
      browser: { ...errorMeta.browser, runtime: settledRuntime },
    });
    expect(recovered).toEqual(settledMeta);
    expect(recovered.status).toBe("error");
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(persistDurableBrowserAnswerMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("owned browser cleanup completed without resubmitting"),
    );
    expect(logSpy.mock.calls.some(([message]) => /reattach|harvest/i.test(String(message)))).toBe(
      false,
    );
  });

  test("serializes overlapping cleanup-only projections and acknowledges after terminal release", async () => {
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
    const targetId = "overlapping-cleanup-only-target";
    const generationId = "b0000000-0000-4000-8000-00000000000b";
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const targetCloseCapability = retainChromeTargetCloseCapability({
      ownerId: "sess",
      generationId,
      targetId,
      close: closeTarget,
    });
    const initialRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          chromeTargetId: targetId,
          targetCloseCapability,
          acquisition: { generationId },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const initialMetadata: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      browser: { runtime: initialRuntime },
      response: { status: "error", incompleteReason: "incomplete-capture" },
      error: {
        category: "browser-automation",
        message: "response identity unavailable",
        details: { reattachable: false },
      },
    };
    let currentMetadata = initialMetadata;
    const { promise: firstProjectionStarted, resolve: markFirstProjectionStarted } =
      Promise.withResolvers<void>();
    const { promise: allowFirstProjection, resolve: resumeFirstProjection } =
      Promise.withResolvers<void>();
    let projectionAttempt = 0;
    sessionStoreMock.updateSession.mockImplementation(async (_sessionId, patch) => {
      projectionAttempt += 1;
      if (projectionAttempt === 1) {
        markFirstProjectionStarted();
        await allowFirstProjection;
      }
      currentMetadata = {
        ...currentMetadata,
        ...patch,
        browser: patch.browser ?? currentMetadata.browser,
      };
    });
    sessionStoreMock.readSession.mockImplementation(async () => currentMetadata);
    let precedingRelease = Promise.resolve();
    const acquireRecoveryLock = vi.fn(async () => {
      const predecessor = precedingRelease;
      const { promise, resolve } = Promise.withResolvers<void>();
      precedingRelease = promise;
      await predecessor;
      return {
        release: async (finalize?: () => Promise<void>) => {
          await finalize?.();
          resolve();
        },
      };
    });
    let cleanupAttempt = 0;
    settleBrowserRecoveryCleanupMock.mockImplementation(
      (
        runtime: BrowserRuntimeMetadata,
        logger: BrowserLogger,
        deps: BrowserRecoverySettlementDeps,
        mode?: "finalize" | "abort",
      ) =>
        settleBrowserRecoveryCleanupActual(
          runtime,
          logger,
          {
            ...deps,
            acquireRecoveryLock,
            finalizeRuntime: async (currentRuntime, settlementMode) => {
              cleanupAttempt += 1;
              if (cleanupAttempt === 1) {
                return pendingBrowserCaptureCleanup(
                  currentRuntime,
                  "first cleanup still pending",
                  settlementMode,
                );
              }
              const resource = currentRuntime.recoveryCleanupResources?.[0];
              if (!resource?.targetCloseCapability || !resource.chromeTargetId) {
                throw new Error("Current cleanup target authority is missing");
              }
              await closeChromeTargetWithRetainedCapability({
                ownerId: "sess",
                capability: resource.targetCloseCapability,
                targetId: resource.chromeTargetId,
                logger,
              });
              return completedBrowserCaptureCleanup(currentRuntime);
            },
          },
          mode,
        ),
    );

    const first = orchestrateBrowserAttachAuthority("sess", initialMetadata);
    await firstProjectionStarted;
    const second = orchestrateBrowserAttachAuthority("sess", initialMetadata);
    await Promise.resolve();
    expect(cleanupAttempt).toBe(1);

    resumeFirstProjection();
    await Promise.all([first, second]);

    expect(cleanupAttempt).toBe(2);
    expect(currentMetadata.browser?.runtime?.recoveryCleanupResources).toBeUndefined();
    expect(currentMetadata.browser?.runtime?.recoveryCleanupResult).toBeUndefined();
    expect(closeTarget).toHaveBeenCalledOnce();
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      1,
    );
  });

  test("retries persisted lock-only abort cleanup after browser resources completed", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResult: {
        status: "failed",
        error: "recovery lock release failed",
        settlementMode: "abort",
      },
    };
    const errorMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      browser: { runtime: pendingRuntime },
    };
    retryBrowserRecoveryCleanupMock.mockResolvedValue({ status: "completed", runtime: {} });
    readSessionMetadataMock
      .mockResolvedValueOnce(errorMeta)
      .mockResolvedValue({ ...errorMeta, browser: { runtime: {} } });
    readSessionLogMock.mockResolvedValue("");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.objectContaining({
        recoveryLockPath: expect.stringMatching(/browser-recovery-[0-9a-f]{24}\.lock$/u),
      }),
      "abort",
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test.each(["finalize", "abort"] as const)(
    "retries persisted local %s cleanup for an error session without acknowledging remote publication",
    async (settlementMode) => {
      const pendingRuntime: BrowserRuntimeMetadata = {
        chromePid: 123,
        chromePort: 9222,
        userDataDir: "/tmp/copied-profile",
        recoveryCleanupResources: [
          {
            chromePid: 123,
            chromePort: 9222,
            userDataDir: "/tmp/copied-profile",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "copied",
              keepBrowser: false,
            },
          },
        ],
        recoveryCleanupResult: {
          status: "failed",
          error: `${settlementMode} retry`,
          settlementMode,
        },
      };
      const errorMeta: SessionMetadata = {
        ...baseMeta,
        status: "error",
        mode: "browser",
        browser: { runtime: pendingRuntime },
      };
      retryBrowserRecoveryCleanupMock.mockResolvedValue({ status: "completed", runtime: {} });
      readSessionMetadataMock
        .mockResolvedValueOnce(errorMeta)
        .mockResolvedValue({ ...errorMeta, browser: { runtime: {} } });
      readSessionLogMock.mockResolvedValue("");
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await attachSession("sess", {
        suppressMetadata: true,
        renderPrompt: false,
        renderMarkdown: false,
      });

      expect(retryBrowserRecoveryCleanupMock).toHaveBeenCalledWith(
        pendingRuntime,
        expect.any(Function),
        expect.objectContaining({
          recoveryLockPath: expect.stringMatching(/browser-recovery-[0-9a-f]{24}\.lock$/u),
        }),
        settlementMode,
      );
      expect(
        retryBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
      ).toBe(false);
      expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    },
  );

  test("reattaches a remote-only error session without local conversation or port metadata", async () => {
    const requestIdentity = {
      acceptedPromptSha256: ["c".repeat(64)],
      followUpOrdinal: 0,
      remainingFollowUps: 0 as const,
    };
    const remoteRecovery = {
      protocolVersion: 3,
      host: "bridge.example:9443",
      transactionToken: "c".repeat(64),
      state: "pre-receipt" as const,
      requestIdentity,
    };
    const remoteToken = "9".repeat(64);
    const resolveCredentials = vi.fn(async () => ({
      host: remoteRecovery.host,
      token: remoteToken,
    }));
    const resolveRemoteRecoveryConfig = createRemoteRecoveryConfigResolver(resolveCredentials);
    const remoteOnlyRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery,
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    const remoteMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      browser: { config: {}, runtime: remoteOnlyRuntime },
      error: {
        category: "browser-automation",
        message: "remote response disconnected",
        details: { recoverableDisconnect: true },
      },
    };
    const capturedRuntime: BrowserRuntimeMetadata = {
      ...committedPromptAuthority("remote-only-conversation"),
      recoveryCleanupResources: [
        {
          conversationId: "remote-only-conversation",
          promptEpoch: committedPromptAuthority("remote-only-conversation").promptEpoch,
          remoteRecovery: { ...remoteRecovery, state: "pending" },
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    resumeBrowserSessionMock.mockResolvedValue({
      answerText: "remote answer",
      answerMarkdown: "remote answer",
      runtime: capturedRuntime,
      bindSettlement: vi.fn(async () => capturedRuntime),
      finalize,
      abort: vi.fn(async () => ({ status: "completed" as const, runtime: {} })),
    });
    readSessionMetadataMock
      .mockResolvedValueOnce(remoteMeta)
      .mockResolvedValue({ ...remoteMeta, status: "completed", browser: { runtime: {} } });
    readSessionLogMock.mockResolvedValue("Answer:\nremote answer");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
      resolveRemoteRecoveryConfig,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("persisted remote browser transaction"),
    );
    expect(resumeBrowserSessionMock).toHaveBeenCalledWith(
      remoteOnlyRuntime,
      {},
      expect.any(Function),
      expect.objectContaining({
        runtimeHintCb: expect.any(Function),
        recoveryCleanup: expect.objectContaining({ resolveRemoteRecoveryConfig }),
      }),
    );
    const recoveryResolver =
      resumeBrowserSessionMock.mock.calls[0]?.[3]?.recoveryCleanup?.resolveRemoteRecoveryConfig;
    await expect(recoveryResolver?.()).resolves.toEqual({
      host: remoteRecovery.host,
      token: remoteToken,
    });
    await expect(recoveryResolver?.()).resolves.toEqual({
      host: remoteRecovery.host,
      token: remoteToken,
    });
    expect(resolveCredentials).toHaveBeenCalledOnce();
    expect(JSON.stringify(sessionStoreMock.updateSession.mock.calls)).not.toContain(remoteToken);
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain(remoteToken);
    expect(finalize).toHaveBeenCalledOnce();
  });

  test("retains pending remote authority when a manual reattach error omits terminal settlement", async () => {
    const staleRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "1".repeat(64),
            state: "pre-receipt",
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    const hintedRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "2".repeat(64),
            state: "recoverable-error",
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    const terminalRuntime: BrowserRuntimeMetadata = {};
    const remoteMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      browser: { config: {}, runtime: staleRuntime },
      error: {
        category: "browser-automation",
        message: "remote response disconnected",
        details: { recoverableDisconnect: true },
      },
    };
    resumeBrowserSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
      const deps = args[3] as
        | { runtimeHintCb?: (runtime: BrowserRuntimeMetadata) => Promise<void> }
        | undefined;
      await deps?.runtimeHintCb?.(hintedRuntime);
      throw new BrowserAutomationError("Remote transaction was already finalized.", {
        stage: "remote-retry",
        code: "remote-transaction-finalized",
        recoverableDisconnect: false,
        runtime: terminalRuntime,
      });
    });
    readSessionMetadataMock.mockResolvedValue(remoteMeta);
    readSessionLogMock.mockResolvedValue("");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    const runtimeUpdates = sessionStoreMock.updateSession.mock.calls
      .map(([, patch]) => patch.browser?.runtime)
      .filter((candidate) => candidate !== undefined);
    expect(runtimeUpdates).toContainEqual(hintedRuntime);
    expect(runtimeUpdates.at(-1)).toEqual(hintedRuntime);
  });

  test("persists a verified answer receipt before manual reattach completion and cleanup", async () => {
    const recoverableMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: {
        config: { chromePath: null },
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "manual-recovery-target",
          tabUrl: "https://chatgpt.com/c/manual-recovery",
          recoveryCleanupResources: [
            {
              chromePort: 9222,
              chromeHost: "127.0.0.1",
              chromeTargetId: "manual-recovery-target",
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "none",
                keepBrowser: true,
              },
            },
          ],
          recoveryCleanupResult: { status: "pending" },
          ...committedPromptAuthority("manual-recovery"),
        },
      },
    } as SessionMetadata;
    const finalizedRuntime = {
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      chromeTargetId: "manual-recovery-target",
      tabUrl: "https://chatgpt.com/c/manual-recovery",
      ...committedPromptAuthority("manual-recovery"),
    };
    const finalize = vi.fn(async () => ({
      status: "completed" as const,
      runtime: finalizedRuntime,
    }));
    const abort = vi.fn(async () => ({
      status: "completed" as const,
      runtime: finalizedRuntime,
    }));
    resumeBrowserSessionMock.mockResolvedValue({
      answerText: "Recovered answer",
      answerMarkdown: "Recovered **answer**",
      runtime: recoverableMeta.browser?.runtime,
      bindSettlement: vi.fn(async () => recoverableMeta.browser?.runtime ?? {}),
      finalize,
      abort,
    });
    readSessionMetadataMock
      .mockResolvedValueOnce(recoverableMeta)
      .mockResolvedValue({ ...recoverableMeta, status: "completed" });
    readSessionLogMock.mockResolvedValue("Answer:\nRecovered **answer**");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    const completedCallIndex = sessionStoreMock.updateSession.mock.calls.findIndex(
      ([, patch]) => patch.status === "completed",
    );
    expect(persistDurableBrowserAnswerMock).toHaveBeenCalledWith(
      {
        sessionId: "sess",
        answer: "Recovered **answer**",
        logHeader: "[reattach] captured assistant response from existing Chrome tab",
        replaceLog: false,
      },
      expect.objectContaining({
        artifact: expect.objectContaining({
          path: expect.stringMatching(/[\\/]artifacts[\\/]browser-answer-[a-f0-9]{64}\.md$/u),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sizeBytes: Buffer.byteLength("Recovered **answer**"),
        }),
      }),
    );
    expect(persistDurableBrowserAnswerMock.mock.invocationCallOrder[0]).toBeLessThan(
      sessionStoreMock.updateSession.mock.invocationCallOrder[completedCallIndex] ?? 0,
    );
    expect(sessionStoreMock.updateSession.mock.calls[completedCallIndex]?.[1]).toMatchObject({
      status: "completed",
      artifacts: [
        expect.objectContaining({
          path: expect.stringMatching(/[\\/]artifacts[\\/]browser-answer-[a-f0-9]{64}\.md$/u),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    });
    expect(finalize.mock.invocationCallOrder[0]).toBeGreaterThan(
      sessionStoreMock.updateSession.mock.invocationCallOrder[completedCallIndex] ?? 0,
    );
    expect(resumeBrowserSessionMock.mock.calls[0]?.[3]?.isRemotePublicationAcknowledged?.()).toBe(
      true,
    );
    expect(resumeBrowserSessionMock.mock.calls[0]?.[3]?.persistFinalizationResult).toEqual(
      expect.any(Function),
    );
    expect(abort).not.toHaveBeenCalled();
  });

  test("does not project unverified receipt after manual journal ambiguity", async () => {
    const runtime = {
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      chromeTargetId: "manual-recovery-target",
      tabUrl: "https://chatgpt.com/c/manual-recovery",
      recoveryCleanupResources: [
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "manual-recovery-target",
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none" as const,
            keepBrowser: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" as const },
      ...committedPromptAuthority("manual-recovery"),
    } satisfies BrowserRuntimeMetadata;
    const recoverableMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: { config: {}, runtime },
    };
    resumeBrowserSessionMock.mockResolvedValue({
      answerText: "captured answer",
      answerMarkdown: "captured answer",
      runtime,
      bindSettlement: vi.fn(async () => runtime),
      finalize: vi.fn(async () => ({ status: "completed" as const, runtime: {} })),
      abort: vi.fn(async () => ({ status: "completed" as const, runtime: {} })),
    });
    vi.spyOn(browserPublicationJournal, "readBrowserCapturePublicationJournal")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("journal reconciliation read failed"))
      .mockResolvedValue(null);
    writeFileAtomicDurableMock.mockRejectedValueOnce(
      new Error("journal write failed before answer persistence"),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await orchestrateBrowserAttachAuthority("sess", recoverableMeta);

    const projectedArtifacts = sessionStoreMock.updateSession.mock.calls.flatMap(
      ([, updates]) => updates.artifacts ?? [],
    );
    expect(projectedArtifacts).toEqual([]);
    expect(persistDurableBrowserAnswerMock).not.toHaveBeenCalled();
  });

  test("aborts manual reattach when durable answer persistence fails", async () => {
    const recoverableMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: {
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "manual-failure-target",
          tabUrl: "https://chatgpt.com/c/manual-failure",
          recoveryCleanupResources: [
            {
              chromePort: 9222,
              chromeHost: "127.0.0.1",
              chromeTargetId: "manual-failure-target",
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "none",
                keepBrowser: true,
              },
            },
          ],
          recoveryCleanupResult: { status: "pending" },
          ...committedPromptAuthority("manual-failure"),
        },
      },
    } as SessionMetadata;
    const finalize = vi.fn();
    const abort = vi.fn(async () => ({
      status: "pending" as const,
      runtime: recoverableMeta.browser?.runtime ?? {},
      error: "target retained for retry",
    }));
    resumeBrowserSessionMock.mockResolvedValue({
      answerText: "Recovered answer",
      answerMarkdown: "Recovered answer",
      runtime: recoverableMeta.browser?.runtime,
      bindSettlement: vi.fn(async () => recoverableMeta.browser?.runtime ?? {}),
      finalize,
      abort,
    });
    persistDurableBrowserAnswerMock.mockRejectedValueOnce(new Error("answer fsync failed"));
    readSessionMetadataMock.mockResolvedValue(recoverableMeta);
    readSessionLogMock.mockResolvedValue("incomplete");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    expect(abort).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls).not.toContainEqual([
      "sess",
      expect.objectContaining({ status: "completed" }),
    ]);
    const authorityUpdateIndex = sessionStoreMock.updateSession.mock.calls.findIndex(
      ([, patch]) => patch.browser?.runtime?.recoveryCleanupResult?.settlementMode === "abort",
    );
    expect(authorityUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(
      sessionStoreMock.updateSession.mock.invocationCallOrder[authorityUpdateIndex],
    ).toBeGreaterThan(abort.mock.invocationCallOrder[0] ?? 0);
    expect(resumeBrowserSessionMock.mock.calls[0]?.[3]?.isRemotePublicationAcknowledged?.()).toBe(
      false,
    );
  });

  test("does not reattach epoch-less runtime state", async () => {
    const staleMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      mode: "browser",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: {
        runtime: {
          chromePort: 9222,
          controllerPid: 2_147_483_647,
          tabUrl: "https://chatgpt.com/c/stale-boolean",
        },
      },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(staleMeta);
    readSessionLogMock.mockResolvedValue("incomplete");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      suppressMetadata: true,
      renderPrompt: false,
      renderMarkdown: false,
    });

    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Attempting to reattach to the existing Chrome session"),
    );
  });
});
