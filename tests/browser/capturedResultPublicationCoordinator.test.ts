import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CommittedPromptEpochLocator } from "../../src/browser/reattachability.js";
import type { BrowserRunLifecycleController } from "../../src/browser/runLifecycle.js";
import type { BrowserLogger, BrowserRunResult } from "../../src/browser/types.js";
import {
  publishCapturedBrowserResult,
  type CapturedBrowserResult,
} from "../../src/browser/capturedResultPublicationCoordinator.js";

const mocks = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock("../../src/browser/artifacts.js", () => ({
  appendArtifacts: (current: unknown[] | undefined, artifacts: unknown[]) => [
    ...(current ?? []),
    ...artifacts.filter(Boolean),
  ],
  saveDeepResearchReportArtifact: async () => {
    mocks.events.push("report");
    return { kind: "deep-research-report", path: "/artifacts/report.md" };
  },
  saveBrowserTranscriptArtifact: async () => {
    mocks.events.push("transcript");
    return { kind: "browser-transcript", path: "/artifacts/transcript.md" };
  },
}));

vi.mock("../../src/browser/chatgptImages.js", () => ({
  collectGeneratedImageArtifacts: async () => {
    mocks.events.push("images");
    return {
      answerText: "answer with image",
      markdownSuffix: "\n\nimage saved",
      generatedImages: [{ url: "https://chatgpt.com/image" }],
      savedImages: [{ kind: "image", path: "/artifacts/image.png", url: "image" }],
      imageCount: 1,
    };
  },
}));

vi.mock("../../src/browser/chatgptFiles.js", () => ({
  collectChatGptFileArtifacts: async () => {
    mocks.events.push("files");
    return {
      files: [{ url: "https://chatgpt.com/backend-api/files/file-1/download" }],
      savedFiles: [{ kind: "file", path: "/artifacts/file.txt", url: "file" }],
      fileCount: 1,
    };
  },
}));

vi.mock("../../src/browser/archiveSettlementCoordinator.js", () => ({
  assertCommittedPromptEpochCurrent: async () => {
    mocks.events.push("prompt-current");
  },
  assertPostArchivePromptEpochCurrent: async () => {
    mocks.events.push("post-archive-current");
  },
  createPromptEpochGuardedRuntime: (Runtime: unknown) => {
    mocks.events.push("guard-runtime");
    return Runtime;
  },
  maybeArchiveCompletedConversation: async (params: {
    followUpCount: number;
    requiredArtifactsSaved: boolean;
  }) => {
    mocks.events.push(`archive:${params.followUpCount}:${params.requiredArtifactsSaved}`);
    return { mode: "always", attempted: true, archived: true };
  },
}));

vi.mock("../../src/browser/utils.js", () => ({
  estimateTokenCount: () => 7,
}));

const promptLocator: CommittedPromptEpochLocator = {
  epoch: {
    status: "committed",
    epochId: "epoch-1",
    promptSha256: "a".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "turn-1",
    verifiedUserMessageId: "message-1",
    conversationId: "conversation-1",
  },
  conversationId: "conversation-1",
  promptSha256: "a".repeat(64),
  verifiedUserTurnIndex: 0,
  verifiedUserTurnId: "turn-1",
  verifiedUserMessageId: "message-1",
  conversationUrls: ["https://chatgpt.com/c/conversation-1"],
};

async function publish(captured: CapturedBrowserResult): Promise<BrowserRunResult> {
  const runtime = { browserTransport: "cdp" as const };
  const lifecycle = {
    runtime: () => runtime,
    issueCapture: (capture: BrowserRunResult) => {
      mocks.events.push("issue-capture");
      return { ...capture, runtime };
    },
  } as unknown as BrowserRunLifecycleController;
  const logger = (() => undefined) as BrowserLogger;
  return publishCapturedBrowserResult({
    captured,
    state: { runStatus: "attempted", publishableCapture: null },
    lifecycle,
    Network: {} as never,
    Runtime: {} as never,
    options: {
      prompt: "prompt",
      sessionId: "session",
      preArchiveCaptureCb: async () => {
        mocks.events.push("pre-archive-capture");
      },
    },
    config: {} as never,
    promptText: "prompt",
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    modelSelection: undefined,
    logger,
    startedAt: Date.now(),
    buildRuntimeMetadata: () => runtime,
    adapters: {
      artifactWriteAuthority: { artifactsDirectory: "/artifacts" },
      imageDownloadAuthority: { Page: {} as never },
      fileDownloadAuthority: { Page: {} as never },
      setPendingWork: (work) => {
        mocks.events.push(`pending:${work.code}`);
      },
      assertFinalLiveness: () => {
        mocks.events.push("final-liveness");
      },
    },
  });
}

describe("captured browser result publication", () => {
  beforeEach(() => {
    mocks.events.length = 0;
  });

  test("publishes conversation artifacts only after every prompt-authority check", async () => {
    const result = await publish({
      kind: "conversation",
      promptLocator,
      answerText: "answer",
      answerMarkdown: "answer",
      answerHtml: "<p>answer</p>",
      followUpCount: 2,
    });

    expect(result).toMatchObject({
      answerText: "answer with image",
      archive: { archived: true },
      answerTokens: 7,
    });
    expect(mocks.events).toEqual([
      "prompt-current",
      "guard-runtime",
      "images",
      "prompt-current",
      "files",
      "prompt-current",
      "transcript",
      "prompt-current",
      "pre-archive-capture",
      "pending:browser-archive-pending",
      "archive:2:true",
      "pending:browser-final-identity-verification-pending",
      "post-archive-current",
      "pending:browser-final-target-liveness-pending",
      "final-liveness",
      "issue-capture",
    ]);
  });

  test("routes Deep Research through the same archive, identity, liveness, and issue ordering", async () => {
    await publish({
      kind: "deep-research",
      promptLocator,
      answerText: "deep answer",
      answerMarkdown: "deep answer",
      answerHtml: "<p>deep answer</p>",
    });

    expect(mocks.events).toEqual([
      "report",
      "transcript",
      "prompt-current",
      "pre-archive-capture",
      "pending:browser-archive-pending",
      "archive:0:true",
      "pending:browser-final-identity-verification-pending",
      "post-archive-current",
      "pending:browser-final-target-liveness-pending",
      "final-liveness",
      "issue-capture",
    ]);
  });
});
