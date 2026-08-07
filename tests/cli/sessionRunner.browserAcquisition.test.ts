import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/oracle.ts", async () => {
  const actual = await vi.importActual<typeof import("../../src/oracle.ts")>("../../src/oracle.ts");
  return {
    ...actual,
    runOracle: vi.fn(),
  };
});

vi.mock("../../src/oracle/multiModelRunner.ts", () => ({
  runMultiModelApiSession: vi.fn(),
}));

vi.mock("../../src/browser/sessionRunner.ts", () => ({
  runBrowserSessionExecution: vi.fn(),
  ensureSessionArtifacts: vi.fn(async ({ existingArtifacts }) => existingArtifacts),
}));

vi.mock("../../src/browser/reattach.ts", () => ({
  resumeBrowserSession: vi.fn(),
  settleBrowserRecoveryCleanup: vi.fn(),
}));
const persistDurableBrowserAnswerMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/cli/durableAnswer.ts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/cli/durableAnswer.ts");
  return {
    ...actual,
    persistDurableBrowserAnswer: persistDurableBrowserAnswerMock,
  };
});

vi.mock("../../src/cli/notifier.ts", () => ({
  sendSessionNotification: vi.fn(async () => undefined),
  deriveNotificationSettingsFromMetadata: vi.fn(() => ({ enabled: true, sound: false })),
}));

const commitSessionModelProjectionMock = vi.hoisted(() => vi.fn());

const sessionStoreMock = vi.hoisted(() => ({
  updateSession: vi.fn(),
  createLogWriter: vi.fn(),
  updateModelRun: vi.fn(),
  readLog: vi.fn(),
  readSession: vi.fn(),
  readRequest: vi.fn(),
  ensureStorage: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  getPaths: vi.fn(),
  readModelLog: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/.oracle/sessions"),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
  commitSessionModelProjection: commitSessionModelProjectionMock,
}));

import type { BrowserRuntimeMetadata } from "../../src/sessionManager.ts";
import {
  baseRunOptions,
  baseSessionMeta,
  committedDemoAuthority,
  createPendingChromeAcquisitionRuntime,
} from "./sessionRunner.fixtures.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.ts";
import { BrowserAutomationError } from "../../src/oracle.ts";
import { runMultiModelApiSession } from "../../src/oracle/multiModelRunner.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.ts";
import { getCliVersion } from "../../src/version.ts";

const log = vi.fn();
const write = vi.fn(() => true);
const cliVersion = getCliVersion();
let testSessionDir: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  testSessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "oracle-test-session-"));
  Object.values(sessionStoreMock).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) {
      fn.mockReset();
    }
  });
  commitSessionModelProjectionMock.mockReset();
  vi.mocked(runMultiModelApiSession).mockReset();
  vi.mocked(resumeBrowserSession).mockReset();
  vi.mocked(settleBrowserRecoveryCleanup).mockReset();
  vi.mocked(runBrowserSessionExecution).mockReset();
  vi.mocked(ensureSessionArtifacts).mockReset();
  vi.mocked(persistDurableBrowserAnswer).mockReset();
  vi.mocked(persistDurableBrowserAnswer).mockImplementation(async (_options, expectedReceipt) => {
    if (!expectedReceipt) throw new Error("publication intent receipt missing");
    return expectedReceipt;
  });
  vi.mocked(ensureSessionArtifacts).mockImplementation(
    async ({ existingArtifacts }) => existingArtifacts,
  );
  vi.mocked(runMultiModelApiSession).mockResolvedValue({
    fulfilled: [],
    rejected: [],
    elapsedMs: 0,
  });
  sessionStoreMock.updateSession.mockImplementation(async (sessionId, updates) => ({
    ...baseSessionMeta,
    id: sessionId,
    ...updates,
  }));
  sessionStoreMock.updateModelRun.mockImplementation(async (_sessionId, model, updates) => ({
    model,
    status: "running",
    ...updates,
  }));
  commitSessionModelProjectionMock.mockImplementation(async (sessionId, projection) => {
    const baseSession = await sessionStoreMock.updateSession(sessionId, projection.session);
    if (!projection.model) return { session: baseSession };
    const model = await sessionStoreMock.updateModelRun(
      sessionId,
      projection.model.model,
      projection.model.updates,
    );
    const session = {
      ...baseSession,
      models: [model],
      modelProjectionAuthority: "session",
    };
    return { session, model };
  });
  sessionStoreMock.readSession.mockResolvedValue(null);
  sessionStoreMock.createLogWriter.mockReturnValue({
    logLine: vi.fn(),
    writeChunk: vi.fn(),
    stream: { end: vi.fn() },
  });
  sessionStoreMock.readModelLog.mockResolvedValue("model log body");
  sessionStoreMock.sessionsDir.mockReturnValue("/tmp/.oracle/sessions");
  sessionStoreMock.getPaths.mockResolvedValue({
    dir: testSessionDir,
    metadata: path.join(testSessionDir, "metadata.json"),
    log: path.join(testSessionDir, "session.log"),
    request: path.join(testSessionDir, "request.json"),
  });
  vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
});
afterEach(async () => {
  await fsPromises.rm(testSessionDir, { recursive: true, force: true });
});

describe("performSessionRun", () => {
  test("reconciles exact epoch-less acquisition authority before restarting a stale browser session", async () => {
    const pendingRuntime = createPendingChromeAcquisitionRuntime();
    const retainedRuntime: BrowserRuntimeMetadata = {
      ...pendingRuntime,
      recoveryCleanupResult: {
        status: "failed",
        error: "Chrome process launch discovery is temporarily unavailable",
        settlementMode: "abort",
      },
    };
    vi.mocked(settleBrowserRecoveryCleanup).mockResolvedValueOnce({
      finalization: {
        status: "pending",
        runtime: retainedRuntime,
        error: "Chrome process launch discovery is temporarily unavailable",
      },
      persistence: { status: "persisted" },
    });

    await expect(
      performSessionRun({
        sessionMeta: {
          ...baseSessionMeta,
          status: "running",
          mode: "browser",
          browser: { config: { chromePath: null }, runtime: pendingRuntime },
        },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/acquisition cleanup remains pending/i);

    expect(settleBrowserRecoveryCleanup).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.objectContaining({
        recoveryLockPath: expect.stringMatching(/browser-recovery-[0-9a-f]{24}\.lock$/u),
      }),
      "abort",
    );
    expect(runBrowserSessionExecution).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime: retainedRuntime },
      error: {
        category: "browser-automation",
        details: { code: "browser-acquisition-cleanup-pending", runtime: retainedRuntime },
      },
    });
  });

  test("starts a replacement browser only after exact acquisition cleanup completes", async () => {
    const pendingRuntime = createPendingChromeAcquisitionRuntime();
    const recoveredRuntime: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
    };
    const freshRuntime: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
      ...committedDemoAuthority,
    };
    const finalize = vi.fn(async () => ({
      status: "completed" as const,
      runtime: freshRuntime,
    }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: freshRuntime }));
    vi.mocked(settleBrowserRecoveryCleanup).mockResolvedValueOnce({
      finalization: { status: "completed", runtime: recoveredRuntime },
      persistence: { status: "persisted" },
    });
    vi.mocked(runBrowserSessionExecution).mockResolvedValueOnce({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 100,
      runtime: freshRuntime,
      answerText: "replacement browser answer",
      bindSettlement: vi.fn(async () => freshRuntime),
      finalize,
      abort,
    });

    await performSessionRun({
      sessionMeta: {
        ...baseSessionMeta,
        status: "error",
        mode: "browser",
        browser: { config: { chromePath: null }, runtime: pendingRuntime },
      },
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(settleBrowserRecoveryCleanup).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.any(Object),
      "abort",
    );
    expect(vi.mocked(settleBrowserRecoveryCleanup).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runBrowserSessionExecution).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "completed",
      browser: { runtime: freshRuntime },
    });
  });

  test("blocks replacement acquisition while cleanup-only lease and process settlement is pending", async () => {
    const acquisitionRuntime = createPendingChromeAcquisitionRuntime();
    const resource = acquisitionRuntime.recoveryCleanupResources?.[0];
    const acquisition = resource?.acquisition;
    const profileDirectory = resource?.profileDirectoryIdentity;
    const launchClaim = acquisition?.processLaunchClaim;
    if (!resource || !acquisition || !profileDirectory || !launchClaim) {
      throw new Error("Missing exact cleanup-only acquisition fixture");
    }
    const acquiredAcquisition = { ...acquisition };
    delete acquiredAcquisition.pendingResource;
    acquiredAcquisition.processOwnerProvenance = "manual-canonical-owner";
    const normalizedUserDataDir =
      process.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath;
    const processIdentity = {
      pid: acquisitionRuntime.chromePid ?? 7_777,
      processStartTime: "cleanup-only-process-generation",
      executablePath:
        process.platform === "win32"
          ? String.raw`c:\program files\google\chrome\application\chrome.exe`
          : process.platform === "darwin"
            ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            : "/usr/bin/google-chrome",
      normalizedUserDataDir,
      launchNonce: launchClaim.nonce,
      launchClaim,
      profileDirectory,
    };
    const cleanupOnlyRuntime: BrowserRuntimeMetadata = {
      ...acquisitionRuntime,
      chromePort: 9222,
      chromeProcessIdentity: processIdentity,
      recoveryCleanupResources: [
        {
          ...resource,
          chromePort: 9222,
          chromeProcessIdentity: processIdentity,
          tabLease: { id: "cleanup-only-lease", profileDirectory },
          acquisition: acquiredAcquisition,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: false,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "lease endpoint update abort remains pending",
        settlementMode: "abort",
      },
    };
    vi.mocked(settleBrowserRecoveryCleanup).mockResolvedValueOnce({
      finalization: {
        status: "pending",
        runtime: cleanupOnlyRuntime,
        error: "lease endpoint update abort remains pending",
      },
      persistence: { status: "persisted" },
    });

    await expect(
      performSessionRun({
        sessionMeta: {
          ...baseSessionMeta,
          status: "error",
          mode: "browser",
          browser: { config: { chromePath: null }, runtime: cleanupOnlyRuntime },
        },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/acquisition cleanup remains pending/i);

    expect(sessionStoreMock.updateSession.mock.calls[0]?.[1]).toMatchObject({
      browser: { runtime: cleanupOnlyRuntime },
    });
    expect(settleBrowserRecoveryCleanup).toHaveBeenCalledWith(
      cleanupOnlyRuntime,
      expect.any(Function),
      expect.any(Object),
      "abort",
    );
    expect(runBrowserSessionExecution).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime: cleanupOnlyRuntime },
      error: {
        category: "browser-automation",
        details: {
          code: "browser-acquisition-cleanup-pending",
          runtime: cleanupOnlyRuntime,
        },
      },
    });
  });

  test("rejects PID-only acquisition state without starting recovery or a replacement browser", async () => {
    const pendingRuntime = createPendingChromeAcquisitionRuntime();
    const resource = pendingRuntime.recoveryCleanupResources?.[0];
    if (!resource?.acquisition) throw new Error("Missing acquisition fixture");
    const malformedRuntime: BrowserRuntimeMetadata = {
      ...pendingRuntime,
      recoveryCleanupResources: [
        {
          ...resource,
          acquisition: { ...resource.acquisition, processLaunchClaim: undefined },
        },
      ],
    };

    await expect(
      performSessionRun({
        sessionMeta: {
          ...baseSessionMeta,
          status: "error",
          mode: "browser",
          browser: { config: { chromePath: null }, runtime: malformedRuntime },
        },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/authority is incomplete or malformed/i);

    expect(settleBrowserRecoveryCleanup).not.toHaveBeenCalled();
    expect(runBrowserSessionExecution).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime: malformedRuntime },
      error: {
        category: "browser-automation",
        details: { code: "browser-acquisition-authority-invalid", runtime: malformedRuntime },
      },
    });
  });

  test("rejects conflicting positive acquisition identities before cleanup admission", async () => {
    const pendingRuntime = createPendingChromeAcquisitionRuntime();
    const resource = pendingRuntime.recoveryCleanupResources?.[0];
    const launchClaim = resource?.acquisition?.processLaunchClaim;
    const profileDirectory = resource?.profileDirectoryIdentity;
    if (!resource || !launchClaim || !profileDirectory) {
      throw new Error("Missing exact acquisition fixture");
    }
    const normalizedUserDataDir =
      process.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath;
    const executablePath =
      process.platform === "win32"
        ? String.raw`c:\program files\google\chrome\application\chrome.exe`
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome";
    const resourceIdentity = {
      pid: 7_777,
      processStartTime: "resource-process-generation",
      executablePath,
      normalizedUserDataDir,
      launchNonce: launchClaim.nonce,
      launchClaim,
      profileDirectory,
    };
    const conflictingClaim = {
      ...launchClaim,
      nonce: "90000000-0000-4000-8000-000000000009",
    };
    const mismatchedRuntime: BrowserRuntimeMetadata = {
      ...pendingRuntime,
      chromeProcessIdentity: {
        ...resourceIdentity,
        processStartTime: "conflicting-process-generation",
        launchNonce: conflictingClaim.nonce,
        launchClaim: conflictingClaim,
      },
      recoveryCleanupResources: [{ ...resource, chromeProcessIdentity: resourceIdentity }],
    };

    await expect(
      performSessionRun({
        sessionMeta: {
          ...baseSessionMeta,
          status: "error",
          mode: "browser",
          browser: { config: { chromePath: null }, runtime: mismatchedRuntime },
        },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/authority is incomplete or malformed/i);

    expect(settleBrowserRecoveryCleanup).not.toHaveBeenCalled();
    expect(runBrowserSessionExecution).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime: mismatchedRuntime },
      error: {
        category: "browser-automation",
        details: { code: "browser-acquisition-authority-invalid", runtime: mismatchedRuntime },
      },
    });
  });

  test("rejects epoch-less recovery authority", async () => {
    const automationError = new BrowserAutomationError("Chrome disconnected", {
      stage: "connection-lost",
      recoverableDisconnect: true,
      disconnectCause: "cdp-client-disconnect",
      runtime: {
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        chromeTargetId: "TARGET-1",
        tabUrl: "https://chatgpt.com/c/demo",
      },
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("Chrome disconnected");

    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
    const logLines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logLines).toContain(
      "Chrome disconnected without recoverable current-prompt commit authority; marking session error.",
    );
    expect(logLines).not.toContain("oracle session sess-1 --render");
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      response: { status: "error", incompleteReason: "chrome-disconnected" },
    });
  });

  test("does not reattach remote cleanup authority after settlement", async () => {
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "f".repeat(64),
            state: "pre-receipt",
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
      recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
    };
    const automationError = new BrowserAutomationError("Chrome disconnected", {
      stage: "connection-lost",
      recoverableDisconnect: true,
      runtime,
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("Chrome disconnected");

    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime },
    });
  });

  test("retains remote-only pre-receipt authority and prints reattach guidance", async () => {
    const remoteRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "d".repeat(64),
            state: "pre-receipt",
            requestIdentity: {
              acceptedPromptSha256: ["e".repeat(64)],
              followUpOrdinal: 0,
              remainingFollowUps: 0,
            },
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    const automationError = new BrowserAutomationError(
      "Remote browser response disconnected before the durable receipt.",
      {
        stage: "remote-retry",
        recoverableDisconnect: true,
        runtime: remoteRuntime,
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/remote browser response disconnected/i);

    const logLines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logLines).toContain("oracle session sess-1 --render");
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: {
        runtime: remoteRuntime,
      },
    });
    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
  });
});
