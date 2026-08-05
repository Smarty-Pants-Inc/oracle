import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  BrowserRuntimeMetadata,
  SessionArtifact,
  SessionMetadata,
} from "../../src/sessionManager.ts";
import {
  buildReattachLine,
  formatResponseMetadata,
  formatBrowserEvidence,
  formatTransportMetadata,
  formatUserErrorMetadata,
  trimBeforeFirstAnswer,
  isDeepResearchPlaceholderCapture,
  attachSession,
} from "../../src/cli/sessionDisplay.ts";
import chalk from "chalk";
import path from "node:path";
import { BrowserAutomationError } from "../../src/oracle/errors.ts";

const waitMock = vi.hoisted(() => vi.fn());
const resumeBrowserSessionMock = vi.hoisted(() => vi.fn());
const retryBrowserRecoveryCleanupMock = vi.hoisted(() => vi.fn());
const persistDurableBrowserAnswerMock = vi.hoisted(() => vi.fn());
const saveBrowserTranscriptArtifactMock = vi.hoisted(() => vi.fn());
const saveDeepResearchReportArtifactMock = vi.hoisted(() => vi.fn());
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
  wait: waitMock,
}));

vi.mock("../../src/sessionManager.ts", () => ({
  wait: vi.fn(),
  writeFileAtomicDurable: vi.fn(),
  syncDirectoryIfSupported: vi.fn(),
}));
vi.mock("../../src/browser/reattach.ts", () => ({
  resumeBrowserSession: resumeBrowserSessionMock,
  retryBrowserRecoveryCleanup: retryBrowserRecoveryCleanupMock,
}));

vi.mock("../../src/cli/durableAnswer.ts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/cli/durableAnswer.ts");
  return {
    ...actual,
    persistDurableBrowserAnswer: persistDurableBrowserAnswerMock,
  };
});

vi.mock("../../src/browser/artifacts.ts", () => ({
  appendArtifacts: (
    existing: SessionArtifact[] | undefined,
    additions: Array<SessionArtifact | null | undefined>,
  ): SessionArtifact[] | undefined => {
    const artifacts = [...(existing ?? []), ...additions.filter((value) => value != null)];
    return artifacts.length > 0 ? (artifacts as SessionArtifact[]) : undefined;
  },
  saveBrowserTranscriptArtifact: saveBrowserTranscriptArtifactMock,
  saveDeepResearchReportArtifact: saveDeepResearchReportArtifactMock,
}));

vi.mock("../../src/cli/markdownRenderer.ts", () => {
  return {
    renderMarkdownAnsi: vi.fn((s: string) => `RENDER:${s}`),
  };
});

const _sessionManagerMock = await import("../../src/sessionManager.ts");
const markdownMock = await import("../../src/cli/markdownRenderer.ts");
const renderMarkdownMock = markdownMock.renderMarkdownAnsi as unknown as { mockClear?: () => void };
const readSessionMetadataMock = sessionStoreMock.readSession as unknown as ReturnType<typeof vi.fn>;
const readSessionLogMock = sessionStoreMock.readLog as unknown as ReturnType<typeof vi.fn>;
const readModelLogMock = sessionStoreMock.readModelLog as unknown as ReturnType<typeof vi.fn>;
const readSessionRequestMock = sessionStoreMock.readRequest as unknown as ReturnType<typeof vi.fn>;

const originalIsTty = process.stdout.isTTY;
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
          version: 1,
          platform: process.platform,
          canonicalPath: userDataDir,
          device: "1",
          inode: "2",
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

beforeEach(() => {
  vi.useFakeTimers();
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
  for (const mock of [
    resumeBrowserSessionMock,
    retryBrowserRecoveryCleanupMock,
    persistDurableBrowserAnswerMock,
    saveBrowserTranscriptArtifactMock,
    saveDeepResearchReportArtifactMock,
  ]) {
    mock.mockReset();
  }
  sessionStoreMock.sessionsDir.mockReturnValue("/tmp/sessions");
  sessionStoreMock.getPaths.mockResolvedValue({
    dir: "/tmp/sessions/sess",
    log: "/tmp/sessions/sess/session.log",
  });
  persistDurableBrowserAnswerMock.mockImplementation(async (_options, expectedReceipt) => {
    if (!expectedReceipt) throw new Error("publication intent receipt missing");
    return expectedReceipt;
  });
  saveBrowserTranscriptArtifactMock.mockResolvedValue(null);
  saveDeepResearchReportArtifactMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  process.exitCode = undefined;
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
  chalk.level = originalChalkLevel;
  vi.restoreAllMocks();
});

describe("formatResponseMetadata", () => {
  test("returns null when metadata missing", () => {
    expect(formatResponseMetadata(undefined)).toBeNull();
  });

  test("joins available metadata parts", () => {
    expect(
      formatResponseMetadata({
        responseId: "resp-123",
        requestId: "req-456",
        status: "completed",
        incompleteReason: undefined,
      }),
    ).toBe("response=resp-123 | request=req-456 | status=completed");
  });
});

describe("formatTransportMetadata", () => {
  test("returns friendly label for known reasons", () => {
    expect(formatTransportMetadata({ reason: "client-timeout" })).toContain("client timeout");
  });

  test("falls back to null when not provided", () => {
    expect(formatTransportMetadata()).toBeNull();
  });
});

describe("formatUserErrorMetadata", () => {
  test("returns null when not provided", () => {
    expect(formatUserErrorMetadata()).toBeNull();
  });

  test("formats category, message, and details", () => {
    expect(
      formatUserErrorMetadata({
        category: "file-validation",
        message: "Too big",
        details: { path: "foo.txt" },
      }),
    ).toBe('file-validation | message=Too big | details={"path":"foo.txt"}');
  });

  test("projects persisted recovery authority out of terminal diagnostics", () => {
    const transactionToken = "transaction-token-keep-in-metadata-only-1234567890";
    const remoteHost = "bridge-recovery.internal.example";
    const websocketEndpoint = "ws://127.0.0.1:9222/devtools/browser/recovery-secret";
    const profilePath = "/Users/alice/Library/Application Support/Chrome/recovery-profile";
    const processLaunchClaim = "launch-claim-keep-in-metadata-only";

    const formatted = formatUserErrorMetadata({
      category: "browser-automation",
      message: `Chrome disconnected at ${websocketEndpoint}; transactionToken=${transactionToken}`,
      details: {
        stage: "connection-lost",
        cause: "The browser connection closed before the answer was captured.",
        status: "recoverable-error",
        userAction: "Run oracle session sess to retry capture.",
        runtime: {
          chromePid: 424_242,
          chromeBrowserWSEndpoint: websocketEndpoint,
          userDataDir: profilePath,
          chromeProcessIdentity: { pid: 424_242, processLaunchClaim },
          recoveryCleanupResources: [
            {
              remoteRecovery: { host: remoteHost, transactionToken },
              acquisition: { processLaunchClaim },
            },
          ],
        },
        details: {
          RUNTIME: {
            recoveryCleanupResources: [
              {
                remoteRecovery: { Host: remoteHost, Transaction_Token: transactionToken },
                chromePid: 424_242,
                chromeBrowserWSEndpoint: websocketEndpoint,
                userDataDir: profilePath,
                acquisition: { processLaunchClaim },
              },
            ],
          },
          causes: [
            {
              StAtUs: "recoverable-error",
              ChRoMe_BrOwSeR_Ws_EnDpOiNt: websocketEndpoint,
              ChRoMe_PiD: 424_242,
              UsEr_DaTa_DiR: profilePath,
              PrOcEsS_LaUnCh_ClAiM: processLaunchClaim,
              ReCoVeRy_CleanUp_Resources: [
                { remoteRecovery: { host: remoteHost, transactionToken } },
              ],
            },
          ],
        },
      },
    });

    expect(formatted).toContain('stage":"connection-lost');
    expect(formatted).toContain('cause":"The browser connection closed');
    expect(formatted).toContain('status":"recoverable-error');
    expect(formatted).toContain('userAction":"Run oracle session sess');
    expect(formatted).toContain('StAtUs":"recoverable-error');
    expect(formatted).toContain("[redacted-endpoint]");
    expect(formatted).toContain("transactionToken=[redacted]");
    expect(formatted).not.toContain(transactionToken);
    expect(formatted).not.toContain(remoteHost);
    expect(formatted).not.toContain(websocketEndpoint);
    expect(formatted).not.toContain(profilePath);
    expect(formatted).not.toContain(processLaunchClaim);
    expect(formatted).not.toContain("424242");
    expect(formatted).not.toContain("runtime");
    expect(formatted).not.toContain("recoveryCleanupResources");
  });
});

describe("formatBrowserEvidence", () => {
  test("formats model selection and warning metadata", () => {
    const metadata: SessionMetadata = {
      id: "sess",
      createdAt: new Date().toISOString(),
      status: "completed",
      options: {},
      browser: {
        modelSelection: {
          requestedModel: "GPT-5.5 Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-05-13T00:00:00.000Z",
        },
        warnings: [
          {
            code: "browser-pro-fast-large-run",
            severity: "warning",
            message: "Large browser Pro run completed quickly.",
          },
        ],
      },
    };

    expect(formatBrowserEvidence(metadata)).toEqual([
      "model requestedKey=(none); target=GPT-5.5 Pro; resolvedLabel=Pro; status=already-selected; strategy=select; verified=yes; source=chatgpt-model-picker; capturedAt=2026-05-13T00:00:00.000Z",
      "warning browser-pro-fast-large-run: Large browser Pro run completed quickly.",
    ]);
  });
});

describe("buildReattachLine", () => {
  test("returns message only when session running", () => {
    const now = Date.UTC(2025, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const metadata: SessionMetadata = {
      id: "session-123",
      createdAt: new Date(now - 30_000).toISOString(),
      status: "running",
      options: {},
    };
    expect(buildReattachLine(metadata)).toBe(
      "Session session-123 reattached, request started 30s ago.",
    );
  });

  test("returns null for completed sessions", () => {
    const metadata: SessionMetadata = {
      id: "done",
      createdAt: new Date().toISOString(),
      status: "completed",
      options: {},
    };
    expect(buildReattachLine(metadata)).toBeNull();
  });

  test("reports retained remote recovery and finalization authority", () => {
    const now = Date.UTC(2025, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const remoteRecovery = {
      protocolVersion: 3,
      host: "bridge.example:9443",
      transactionToken: "f".repeat(64),
      state: "pending" as const,
    };
    const metadata: SessionMetadata = {
      id: "remote",
      createdAt: new Date(now - 30_000).toISOString(),
      status: "error",
      mode: "browser",
      options: {},
      browser: {
        runtime: {
          recoveryCleanupResources: [
            {
              remoteRecovery,
              recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
            },
          ],
        },
      },
    };

    expect(buildReattachLine(metadata)).toBe(
      "Session remote retained recoverable remote browser authority from 30s ago.",
    );
    expect(
      buildReattachLine({
        ...metadata,
        status: "completed",
        browser: {
          runtime: {
            recoveryCleanupResources: [
              {
                remoteRecovery,
                recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
              },
            ],
            recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
          },
        },
      }),
    ).toBe("Session remote retained pending remote browser finalization from 30s ago.");
  });
});

describe("trimBeforeFirstAnswer", () => {
  test("returns log starting at first Answer marker", () => {
    const input = "intro\nnoise\nAnswer:\nactual content\n";
    expect(trimBeforeFirstAnswer(input)).toBe("Answer:\nactual content\n");
  });

  test("returns original text when marker missing", () => {
    const input = "no answer yet";
    expect(trimBeforeFirstAnswer(input)).toBe(input);
  });

  test("skips stale tool-only capture when a later reattach answer exists", () => {
    const input =
      "Launching browser mode\n" +
      "Answer:\n" +
      "Called tool\n" +
      "[reattach] captured assistant response from existing Chrome tab\n" +
      "Answer:\n" +
      "Recovered report";

    expect(trimBeforeFirstAnswer(input)).toBe("Answer:\nRecovered report");
  });

  test("skips a stale Deep Research App wrapper before a recovered answer", () => {
    const input =
      "Answer:\n" +
      "Called tool\n" +
      "Deep Research App\n" +
      "Response { session_id: abc123 }\n" +
      "[reattach] captured assistant response from existing Chrome tab\n" +
      "Answer:\n" +
      "# Recovered report";

    expect(trimBeforeFirstAnswer(input)).toBe("Answer:\n# Recovered report");
  });
});

describe("isDeepResearchPlaceholderCapture", () => {
  const deepResearchMeta: SessionMetadata = {
    id: "sess",
    createdAt: new Date().toISOString(),
    status: "completed",
    options: {},
  };

  test("flags the bare tool-only stub", () => {
    const log = "Launching browser mode\nAnswer:\nCalled tool\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(true);
  });

  test("flags the multi-line Deep Research App tool-call wrapper", () => {
    const log =
      "Launching browser mode\n" +
      "Answer:\n" +
      "Called tool\n" +
      "Deep Research App\n" +
      "Call tool\n" +
      "Request { prompt: ... }\n" +
      "Response { session_id: abc123 }\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(true);
  });

  test("flags Polish tool-call markers", () => {
    const log = "Answer:\nUżyto narzędzia\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(true);
  });

  test("does not flag a real report answer", () => {
    const log =
      "Answer:\n" +
      "# Research Report\n" +
      "The findings show that the market grew 12% year over year.\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(false);
  });

  test("does not flag prose that happens to begin with a tool-call phrase", () => {
    const log =
      "Answer:\n" +
      "Called tool adoption is accelerating across the market.\n" +
      "The report analyzes the evidence in detail.\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(false);
  });

  test("does not re-flag a wrapper capture that was already recovered", () => {
    const log =
      "Answer:\n" +
      "Called tool\n" +
      "Deep Research App\n" +
      "Response { session_id: abc123 }\n" +
      "[reattach] captured assistant response from existing Chrome tab\n" +
      "Answer:\n" +
      "# Research Report\n" +
      "The recovered findings.\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(false);
  });
});

describe("attachSession rendering", () => {
  const baseMeta: SessionMetadata = {
    id: "sess",
    createdAt: new Date().toISOString(),
    status: "completed",
    options: {},
  };

  beforeEach(() => {
    renderMarkdownMock?.mockClear?.();
    readSessionRequestMock.mockReset();
  });

  test("prints persisted lifecycle metadata", async () => {
    const lifecycleMeta: SessionMetadata = {
      ...baseMeta,
      status: "completed",
      lifecycle: {
        engine: "api",
        execution: "background",
        attached: false,
        detached: true,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(lifecycleMeta);
    readSessionLogMock.mockResolvedValue("");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false });

    expect(logSpy).toHaveBeenCalledWith("Execution: api/bg (detached)");
    expect(logSpy).toHaveBeenCalledWith("Reattach: oracle session sess");
  });

  test("propagates a detached worker failure only when requested", async () => {
    const failedMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      errorMessage: "browser failed",
    };
    readSessionMetadataMock.mockResolvedValue(failedMeta);
    readSessionLogMock.mockResolvedValue("ERROR: browser failed");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false, suppressMetadata: true });
    expect(process.exitCode).toBeUndefined();

    await attachSession("sess", {
      renderMarkdown: false,
      suppressMetadata: true,
      propagateFailure: true,
    });

    expect(process.exitCode).toBe(1);
  });

  test("stops waiting when a detached browser worker exits before completion", async () => {
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          controllerPid: 2_147_483_647,
          tabUrl: "https://chatgpt.com/c/example",
        },
      },
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: 2_147_483_647,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    readSessionMetadataMock
      .mockResolvedValueOnce({
        ...runningMeta,
        browser: {
          ...runningMeta.browser,
          runtime: {
            ...runningMeta.browser?.runtime,
            controllerPid: process.pid,
          },
        },
        lifecycle: {
          ...runningMeta.lifecycle,
          workerPid: process.pid,
        },
      } as SessionMetadata)
      .mockResolvedValue(runningMeta);
    readSessionLogMock.mockResolvedValue("response streaming");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      renderMarkdown: false,
      suppressMetadata: true,
      propagateFailure: true,
    });

    expect(process.exitCode).toBe(1);
    expect(waitMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Detached worker exited before the session reached a terminal state"),
    );
    expect(sessionStoreMock.updateSession).toHaveBeenCalledWith(
      "sess",
      expect.objectContaining({
        status: "error",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      }),
    );
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
        recoveryLockPath: path.join("/tmp/sessions", "sess", "browser-recovery.lock"),
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
        recoveryLockPath: path.join("/tmp/sessions", "sess", "browser-recovery.lock"),
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
        recoveryLockPath: path.join("/tmp/sessions", "sess", "browser-recovery.lock"),
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
        recoveryLockPath: path.join("/tmp/sessions", "sess", "browser-recovery.lock"),
      }),
      "abort",
    );
    expect(
      retryBrowserRecoveryCleanupMock.mock.calls[0]?.[2]?.isRemotePublicationAcknowledged?.(),
    ).toBe(false);
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
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
        recoveryLockPath: path.join("/tmp/sessions", "sess", "browser-recovery.lock"),
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
          recoveryLockPath: path.join("/tmp/sessions", "sess", "browser-recovery.lock"),
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
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("persisted remote browser transaction"),
    );
    expect(resumeBrowserSessionMock).toHaveBeenCalledWith(
      remoteOnlyRuntime,
      {},
      expect.any(Function),
      expect.objectContaining({ runtimeHintCb: expect.any(Function) }),
    );
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
    expect(abort).not.toHaveBeenCalled();
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

  test("does not reattach while the detached browser worker is alive", async () => {
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: {
        runtime: {
          controllerPid: process.pid,
          tabUrl: "https://chatgpt.com/c/example",
        },
      },
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    readSessionMetadataMock
      .mockResolvedValueOnce(runningMeta)
      .mockResolvedValueOnce({ ...runningMeta, status: "completed" });
    readSessionLogMock.mockResolvedValue("response streaming");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false, suppressMetadata: true });

    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Attempting to reattach to the existing Chrome session"),
    );
  });

  test("stops an ordinary attachment when its detached worker exits", async () => {
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          controllerPid: process.pid,
          tabUrl: "https://chatgpt.com/c/example",
        },
      },
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    const deadMeta = {
      ...runningMeta,
      browser: {
        ...runningMeta.browser,
        runtime: {
          ...runningMeta.browser?.runtime,
          controllerPid: 2_147_483_647,
        },
      },
      lifecycle: {
        ...runningMeta.lifecycle,
        workerPid: 2_147_483_647,
      },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValue(deadMeta);
    readSessionLogMock.mockResolvedValue("response streaming");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false, suppressMetadata: true });

    expect(process.exitCode).toBeUndefined();
    expect(sessionStoreMock.updateSession).toHaveBeenCalledWith(
      "sess",
      expect.objectContaining({ status: "error" }),
    );
  });

  test("does not replace completion persisted as the worker exits", async () => {
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
    } as SessionMetadata;
    const deadSnapshot = {
      ...runningMeta,
      lifecycle: {
        ...runningMeta.lifecycle,
        workerPid: 2_147_483_647,
      },
    } as SessionMetadata;
    const completedMeta = { ...deadSnapshot, status: "completed" } as SessionMetadata;
    readSessionMetadataMock
      .mockResolvedValueOnce(runningMeta)
      .mockResolvedValueOnce(deadSnapshot)
      .mockResolvedValue(completedMeta);
    readSessionLogMock.mockResolvedValue("Answer:\ncompleted");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      renderMarkdown: false,
      suppressMetadata: true,
      propagateFailure: true,
    });

    expect(process.exitCode).toBeUndefined();
    expect(sessionStoreMock.updateSession).not.toHaveBeenCalled();
  });

  test("prints chain metadata for follow-up sessions", async () => {
    const followupMeta: SessionMetadata = {
      ...baseMeta,
      options: {
        previousResponseId: "resp_parent_1234",
        followupSessionId: "parent-session",
      },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(followupMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nchild output");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Chain: parent-session (resp_parent_1234) -> sess"),
    );
  });

  test("prints all model runs with status and tokens", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          usage: { inputTokens: 10, outputTokens: 12, reasoningTokens: 0, totalTokens: 24 },
        },
        {
          model: "gemini-3-pro",
          status: "running",
          usage: { inputTokens: 10, outputTokens: 0, reasoningTokens: 0, totalTokens: 10 },
        },
      ],
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nhi");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false });

    expect(logSpy).toHaveBeenCalledWith("Models:");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/gpt-5\.2-pro.*completed tok=12\/24/),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/gemini-3-pro.*running tok=0\/10/));
  });

  test("ignores empty model filter from CLI defaults", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
        },
      ],
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nbody");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write");

    await attachSession("sess", { renderMarkdown: false, model: "" });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("gpt-5.2-pro"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Answer:"));
  });

  test("falls back to session log when per-model logs are empty", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
        },
      ],
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nfrom-session-log");
    // model log missing/empty
    readModelLogMock.mockResolvedValue("");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write");

    await attachSession("sess", { renderMarkdown: false });

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Answer:\nfrom-session-log"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("gpt-5.2-pro"));
  });

  test("renders markdown when requested and rich tty", async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nhello *world*");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Prompt:"));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith("Answer:\nhello *world*");
    expect(writeSpy).toHaveBeenCalledWith("RENDER:Answer:\nhello *world*");
  });

  test("skips render when too large", async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue("A".repeat(210_000));
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Prompt:"));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledTimes(1);
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(
      expect.stringContaining("Prompt here"),
    );
    expect(writeSpy).toHaveBeenCalled(); // raw write
  });

  test("streams rendered chunks during running sessions and honors safe breaks", async () => {
    const runningMeta: SessionMetadata = { ...baseMeta, status: "running" };
    const completedMeta: SessionMetadata = { ...baseMeta, status: "completed" };
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    sessionStoreMock.readSession
      .mockResolvedValueOnce(runningMeta)
      .mockResolvedValueOnce(completedMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    readSessionLogMock
      .mockResolvedValueOnce("Answer:\n| a | b |\n")
      .mockResolvedValueOnce("Answer:\n| a | b |\n| c | d |\n\nDone\n");
    const writeSpy = vi.spyOn(process.stdout, "write");
    waitMock.mockResolvedValue(undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledTimes(2);
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(
      expect.stringContaining("Prompt here"),
    );
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(
      expect.stringContaining("Answer:\n| a | b |"),
    );
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("RENDER:Answer"));
  });

  test("falls back to raw streaming when live render exceeds cap", async () => {
    const runningMeta: SessionMetadata = { ...baseMeta, status: "running" };
    const completedMeta: SessionMetadata = { ...baseMeta, status: "completed" };
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    sessionStoreMock.readSession
      .mockResolvedValueOnce(runningMeta)
      .mockResolvedValueOnce(completedMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const huge = "A".repeat(210_000);
    readSessionLogMock.mockResolvedValueOnce(huge).mockResolvedValueOnce(huge);
    waitMock.mockResolvedValue(undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(
      expect.stringContaining("Prompt here"),
    );
  });

  test("suppresses prompt when renderPrompt is false", async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nhello");
    readSessionRequestMock.mockResolvedValue({ prompt: "Hidden prompt" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true, renderPrompt: false });

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Prompt:"));
  });

  test("shows completion summary with cost and slug when available", async () => {
    const metaWithUsage: SessionMetadata = {
      ...baseMeta,
      status: "completed",
      model: "gpt-5.2-pro",
      mode: "api",
      elapsedMs: 1234,
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30, cost: 1.23 },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(metaWithUsage);
    readSessionLogMock.mockResolvedValue("Answer:\nhello");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("↑"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("↓"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Δ"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("$1.23"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("slug=sess"));
  });

  test("treats partial sessions as terminal", async () => {
    const partialMeta: SessionMetadata = {
      ...baseMeta,
      status: "partial",
      model: "gpt-5.1",
      mode: "api",
      elapsedMs: 1234,
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30 },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(partialMeta);
    sessionStoreMock.readSession.mockResolvedValue(partialMeta);
    readSessionLogMock.mockResolvedValue("Answer:\npartial result");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false });

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Answer:\npartial result"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("↑"));
    expect(waitMock).not.toHaveBeenCalled();
  });

  test("falls back to metadata prompt when request is missing", async () => {
    readSessionMetadataMock.mockResolvedValue({ ...baseMeta, options: { prompt: "From meta" } });
    readSessionLogMock.mockResolvedValue("Answer:\nhello");
    readSessionRequestMock.mockResolvedValue(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Prompt:"));
    expect(renderMarkdownMock).toHaveBeenCalledWith("Answer:\nhello");
  });

  test("prints all per-model logs when multi-model session completes", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
        },
        {
          model: "gemini-3-pro",
          status: "completed",
          usage: { inputTokens: 4, outputTokens: 5, reasoningTokens: 0, totalTokens: 9 },
        },
      ],
    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    sessionStoreMock.readSession.mockResolvedValue(multiMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    sessionStoreMock.readModelLog
      .mockResolvedValueOnce("Answer:\nfrom gpt-5.2-pro")
      .mockResolvedValueOnce("Answer:\nfrom gemini");

    await attachSession("sess", { renderMarkdown: false });

    const written = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("from gpt-5.2-pro");
    expect(written).toContain("=== gemini-3-pro ===");
    expect(written).toContain("from gemini");
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Models:"));
  });

  test("prints only the selected model log when a model filter is provided", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        { model: "gpt-5.2-pro", status: "completed" },
        { model: "gemini-3-pro", status: "completed" },
      ],
    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    sessionStoreMock.readSession.mockResolvedValue(multiMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    sessionStoreMock.readModelLog.mockResolvedValueOnce("Answer:\nfrom gemini only");

    await attachSession("sess", { renderMarkdown: false, model: "Gemini-3-Pro" });

    const written = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("from gemini only");
    expect(written).not.toContain("gpt-5.2-pro");
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(1);
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledWith("sess", "gemini-3-pro");
  });

  test("exits with error when requested model is not part of the session", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        { model: "gpt-5.2-pro", status: "completed" },
        { model: "gemini-3-pro", status: "completed" },
      ],
    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await attachSession("sess", { model: "claude-4.0" });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Model "claude-4.0" not found'));
    expect(process.exitCode).toBe(1);
    expect(sessionStoreMock.readModelLog).not.toHaveBeenCalled();
  });

  test("falls back to per-model log when metadata is legacy but filter provided", async () => {
    const legacyMeta: SessionMetadata = {
      ...baseMeta,
      model: "gpt-5.2-pro",
      models: undefined,
    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(legacyMeta);
    sessionStoreMock.readSession.mockResolvedValue(legacyMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt legacy" });
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\nlegacy per-model");
    const writeSpy = vi.spyOn(process.stdout, "write");

    await attachSession("sess", { renderMarkdown: false, model: "gpt-5.2-pro" });

    const written = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("legacy per-model");
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(1);
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledWith("sess", "gpt-5.2-pro");
    expect(sessionStoreMock.readLog).not.toHaveBeenCalled();
  });
});
