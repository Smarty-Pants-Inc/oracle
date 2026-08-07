import { describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.ts";
import {
  buildReattachLine,
  formatBrowserEvidence,
  formatResponseMetadata,
  formatTransportMetadata,
  formatUserErrorMetadata,
} from "../../src/cli/sessionDisplay.ts";

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
    vi.useFakeTimers();
    try {
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
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });
});
