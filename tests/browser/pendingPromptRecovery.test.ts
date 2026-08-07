import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { unpublishedCleanupPendingError } from "../../src/browser/archiveSettlementCoordinator.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import {
  chatgptDomProvider,
  createChatgptDomProviderState,
  type ChatgptDomAdapter,
} from "../../src/browser/providers/chatgptDomProvider.js";
import {
  createGeminiDeepThinkDomProviderState,
  geminiDeepThinkDomProvider,
} from "../../src/browser/providers/geminiDeepThinkDomProvider.js";
import {
  reconcilePendingPromptObservations,
  type DomEvaluate,
  type PendingPromptObservation,
  type PendingPromptEpochAuthority,
} from "../../src/browser/providerDomFlow.js";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.js";
import { resolvePendingPromptEpochAuthority } from "../../src/browser/reattachability.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { createBrowserLogger, restartBoundProcessIdentity } from "./reattachTestHelpers.js";

const PROMPT = "Recover this exact prompt";
const PROMPT_SHA256 = promptIdentitySha256(PROMPT);
const OWNER_ID = "pending-epoch-owner";
const TARGET_ID = "pending-target";
const CONVERSATION_ID = "pending-conversation";
const GENERATION_ID = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "ws://127.0.0.1:51559/devtools/browser/pending-browser";

function pendingRuntime(): BrowserRuntimeMetadata {
  const userDataDir = "/tmp/oracle-pending-epoch-profile";
  const processIdentity = restartBoundProcessIdentity(userDataDir, 4321, GENERATION_ID);
  const promptEpoch = {
    status: "pending" as const,
    epochId: "pending-epoch",
    promptSha256: PROMPT_SHA256,
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
  };
  return {
    browserTransport: "cdp",
    chromePid: processIdentity.pid,
    chromeProcessIdentity: processIdentity,
    chromeHost: "127.0.0.1",
    chromePort: 51559,
    chromeBrowserWSEndpoint: ENDPOINT,
    userDataDir,
    chromeTargetId: TARGET_ID,
    tabUrl: `https://chatgpt.com/c/${CONVERSATION_ID}`,
    conversationId: CONVERSATION_ID,
    promptEpoch,
    recoveryCleanupResources: [
      {
        chromePid: processIdentity.pid,
        chromeProcessIdentity: processIdentity,
        profileDirectoryIdentity: processIdentity.profileDirectory,
        chromeHost: "127.0.0.1",
        chromePort: 51559,
        chromeBrowserWSEndpoint: ENDPOINT,
        userDataDir,
        chromeTargetId: TARGET_ID,
        conversationId: CONVERSATION_ID,
        promptEpoch,
        acquisition: {
          generationId: GENERATION_ID,
          processLaunchClaim: processIdentity.launchClaim,
        },
        targetCloseCapability: {
          version: 1,
          generationId: GENERATION_ID,
          capabilityId: "pending-close-capability",
          ownerIdSha256: createHash("sha256").update(OWNER_ID).digest("hex"),
          targetId: TARGET_ID,
          browserWSEndpoint: ENDPOINT,
        },
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: true,
          closeOwnedTargetOnComplete: true,
        },
      },
    ],
    recoveryCleanupResult: { status: "pending" },
  };
}

function committedVerification() {
  return {
    committedTurns: 2,
    promptSha256: PROMPT_SHA256,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "prompt-turn",
    verifiedUserMessageId: "prompt-message",
    conversationId: CONVERSATION_ID,
  };
}

function pendingProvider(
  reconcile: NonNullable<ChatgptDomAdapter["reconcilePendingPrompt"]>,
): ChatgptDomAdapter {
  return {
    provider: "chatgpt",
    providerName: "pending-test-provider",
    waitForUi: vi.fn(async () => undefined),
    typePrompt: vi.fn(async () => undefined),
    submitPrompt: vi.fn(async () => ({
      status: "committed" as const,
      verification: committedVerification(),
    })),
    reconcilePendingPrompt: reconcile,
    waitForResponse: vi.fn(async () => ({ text: "unused" })),
  };
}

function attachedClient() {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
    result: {
      value: expression.includes("const clearEditable =")
        ? { cleared: true, remaining: [] }
        : expression === "location.href"
          ? `https://chatgpt.com/c/${CONVERSATION_ID}`
          : expression === "1+1"
            ? 2
            : null,
    },
  }));
  const client = {
    Runtime: { enable: vi.fn(async () => undefined), evaluate },
    DOM: { enable: vi.fn(async () => undefined) },
    close: vi.fn(async () => undefined),
  };
  return {
    client,
    connect: vi.fn(async () => client) as unknown as (options?: unknown) => Promise<ChromeClient>,
  };
}

async function resumePending(options: {
  provider: ChatgptDomAdapter;
  runtimeHintCb?: (runtime: BrowserRuntimeMetadata) => Promise<void>;
}) {
  const runtime = pendingRuntime();
  const { client, connect } = attachedClient();
  const release = vi.fn(async () => undefined);
  const result = await resumeBrowserSession(runtime, { timeoutMs: 2_000 }, createBrowserLogger(), {
    sessionId: OWNER_ID,
    pendingPromptCandidates: [PROMPT],
    pendingPromptProviders: { chatgpt: options.provider },
    runtimeHintCb: options.runtimeHintCb ?? vi.fn(async () => undefined),
    acquireRecoveryLock: vi.fn(async () => ({ release })),
    listTargets: vi.fn(async () => [
      {
        targetId: TARGET_ID,
        type: "page",
        url: `https://chatgpt.com/c/${CONVERSATION_ID}`,
      },
    ]),
    connect,
    waitForConversationHydration: vi.fn(async () => 2),
    verifyCommittedPromptTurn: vi.fn(async () => undefined),
    waitForAssistantResponse: vi.fn(async () => ({
      text: "Recovered answer",
      html: "",
      meta: { turnId: "answer-turn", messageId: "answer-message" },
    })),
    captureAssistantMarkdown: vi.fn(async () => "Recovered answer"),
  });
  return { result, client, release };
}

function observation(overrides: Partial<PendingPromptObservation> = {}): PendingPromptObservation {
  return {
    ready: true,
    conversationId: CONVERSATION_ID,
    composerText: "",
    canSubmit: false,
    active: false,
    turns: [
      {
        role: "user",
        text: PROMPT,
        turnId: "prompt-turn",
        messageId: "prompt-message",
      },
      {
        role: "assistant",
        text: "Recovered answer",
        turnId: "answer-turn",
        messageId: "answer-message",
      },
    ],
    ...overrides,
  };
}

describe("pending prompt epoch restart reconciliation", () => {
  test("requires the exact durable endpoint owner for pending recovery", () => {
    const runtime = pendingRuntime();

    expect(resolvePendingPromptEpochAuthority(runtime, OWNER_ID)).toMatchObject({
      targetId: TARGET_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(resolvePendingPromptEpochAuthority(runtime, "different-owner")).toBeNull();
  });

  test("promotes an externally committed send without replaying it", async () => {
    const provider = pendingProvider(
      vi.fn(async () => ({
        status: "committed" as const,
        prompt: PROMPT,
        verification: committedVerification(),
      })),
    );
    const runtimeHints: BrowserRuntimeMetadata[] = [];

    const { result, client } = await resumePending({
      provider,
      runtimeHintCb: async (runtime) => {
        runtimeHints.push(runtime);
      },
    });

    expect(provider.submitPrompt).not.toHaveBeenCalled();
    expect(
      client.Runtime.evaluate.mock.calls.some(([{ expression }]) =>
        expression.includes("const clearEditable ="),
      ),
    ).toBe(false);
    expect(result.answerMarkdown).toBe("Recovered answer");
    expect(result.runtime.promptEpoch).toMatchObject({
      status: "committed",
      epochId: "pending-epoch",
      promptSha256: PROMPT_SHA256,
      verifiedUserTurnId: "prompt-turn",
      verifiedUserMessageId: "prompt-message",
    });
    expect(runtimeHints.at(-1)?.promptEpoch?.status).toBe("committed");
    expect(client.close).toHaveBeenCalledOnce();
  });

  test("keeps exact committed authority in memory when promotion persistence fails", async () => {
    const provider = pendingProvider(
      vi.fn(async () => ({
        status: "committed" as const,
        prompt: PROMPT,
        verification: committedVerification(),
      })),
    );
    const persist = vi.fn(async (runtime: BrowserRuntimeMetadata) => {
      if (runtime.promptEpoch?.status === "committed") throw new Error("runtime store unavailable");
    });

    const { result } = await resumePending({ provider, runtimeHintCb: persist });

    expect(provider.submitPrompt).not.toHaveBeenCalled();
    expect(result.runtime.promptEpoch?.status).toBe("committed");
    expect(result.answerMarkdown).toBe("Recovered answer");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "prompt-commit-journal-pending" }),
    );
  });

  test("classifies non-send only from two stable exact composer observations", () => {
    const nonSent: PendingPromptObservation = {
      ready: true,
      conversationId: CONVERSATION_ID,
      composerText: PROMPT,
      canSubmit: true,
      active: false,
      turns: [],
    };
    const authority = {
      promptSha256: PROMPT_SHA256,
      baselineTurns: 0,
      conversationId: CONVERSATION_ID,
    };

    expect(reconcilePendingPromptObservations(nonSent, nonSent, authority)).toEqual({
      status: "not-committed",
    });
    expect(
      reconcilePendingPromptObservations(nonSent, { ...nonSent, composerText: "" }, authority),
    ).toMatchObject({ status: "ambiguous" });
  });

  test("replays once only after exact non-commit proof", async () => {
    const provider = pendingProvider(vi.fn(async () => ({ status: "not-committed" as const })));

    const { result, client } = await resumePending({ provider });

    expect(provider.waitForUi).toHaveBeenCalledOnce();
    expect(provider.typePrompt).toHaveBeenCalledOnce();
    expect(provider.submitPrompt).toHaveBeenCalledOnce();
    expect(provider.submitPrompt).toHaveBeenCalledWith(expect.objectContaining({ prompt: PROMPT }));
    expect(
      client.Runtime.evaluate.mock.calls.filter(([{ expression }]) =>
        expression.includes("const clearEditable ="),
      ),
    ).toHaveLength(1);
    const clearCallIndex = client.Runtime.evaluate.mock.calls.findIndex(([{ expression }]) =>
      expression.includes("const clearEditable ="),
    );
    expect(client.Runtime.evaluate.mock.invocationCallOrder[clearCallIndex]).toBeLessThan(
      vi.mocked(provider.submitPrompt).mock.invocationCallOrder[0]!,
    );
    expect(result.runtime.promptEpoch).toMatchObject({
      status: "committed",
      epochId: "pending-epoch",
      promptSha256: PROMPT_SHA256,
    });
  });

  test("recognizes the exact sent turn even when unrelated later turns exist", () => {
    const withLaterTurn = observation({
      turns: [
        ...observation().turns,
        {
          role: "user",
          text: "An unrelated later prompt",
          turnId: "later-turn",
          messageId: "later-message",
        },
        {
          role: "assistant",
          text: "A later answer",
          turnId: "later-answer-turn",
          messageId: "later-answer-message",
        },
      ],
    });

    expect(
      reconcilePendingPromptObservations(withLaterTurn, withLaterTurn, {
        promptSha256: PROMPT_SHA256,
        baselineTurns: 0,
        conversationId: CONVERSATION_ID,
      }),
    ).toMatchObject({
      status: "committed",
      verification: {
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "prompt-turn",
        verifiedUserMessageId: "prompt-message",
      },
    });
  });

  test("surfaces a pending crash as reattachable reconciliation rather than cleanup", () => {
    const runtime = pendingRuntime();
    const error = unpublishedCleanupPendingError({
      status: "pending",
      runtime,
      error: "Pending prompt dispatch must be reconciled",
    });

    expect(error).toMatchObject({
      details: {
        stage: "prompt-epoch-reconciliation",
        code: "pending-prompt-epoch-ambiguous",
        reattachable: true,
        recoverableDisconnect: true,
        runtime,
      },
    });
  });

  test("does not abort or clean up a pending epoch during cleanup-only restart", async () => {
    const runtime = pendingRuntime();
    const release = vi.fn(async () => undefined);
    const finalizeRuntime = vi.fn();
    const persistFinalizationResult = vi.fn();

    const outcome = await settleBrowserRecoveryCleanup(
      runtime,
      createBrowserLogger(),
      {
        ownerId: OWNER_ID,
        acquireRecoveryLock: vi.fn(async () => ({ release })),
        loadRuntimeUnderLock: vi.fn(async () => runtime),
        finalizeRuntime,
        persistFinalizationResult,
      },
      "abort",
    );

    expect(outcome).toMatchObject({
      finalization: { status: "pending", runtime },
      persistence: { status: "persisted" },
    });
    expect(outcome.finalization.runtime.recoveryCleanupResult?.settlementMode).toBeUndefined();
    expect(finalizeRuntime).not.toHaveBeenCalled();
    expect(persistFinalizationResult).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  test("ChatGPT and Gemini adapters reconcile exact provider-bound observations", async () => {
    const exactObservation = observation();
    const authority: PendingPromptEpochAuthority = {
      promptSha256: PROMPT_SHA256,
      baselineTurns: 0,
      conversationId: CONVERSATION_ID,
    };
    const chatgptEvaluations: string[] = [];
    const chatgptEvaluate: DomEvaluate = async <T>(expression: string) => {
      chatgptEvaluations.push(expression);
      return exactObservation as T;
    };
    await expect(
      chatgptDomProvider.reconcilePendingPrompt?.(
        {
          evaluate: chatgptEvaluate,
          delay: vi.fn(async () => undefined),
          state: createChatgptDomProviderState({
            runtime: {} as ChromeClient["Runtime"],
            input: {} as ChromeClient["Input"],
            logger: createBrowserLogger(),
            timeoutMs: 2_000,
            baselineTurns: 0,
          }),
        },
        authority,
      ),
    ).resolves.toMatchObject({
      status: "committed",
      verification: {
        verifiedUserTurnId: "prompt-turn",
        verifiedUserMessageId: "prompt-message",
      },
    });

    const geminiEvaluations: string[] = [];
    const geminiEvaluate: DomEvaluate = async <T>(expression: string) => {
      geminiEvaluations.push(expression);
      return JSON.stringify({
        ready: true,
        composerText: "",
        canSubmit: false,
        active: false,
        entries: [
          { kind: "user", text: PROMPT, stableId: "prompt-turn" },
          {
            kind: "response",
            text: "Recovered answer",
            stableId: "answer-turn",
            completionMarked: true,
            visibleSpinner: false,
          },
        ],
      }) as T;
    };
    await expect(
      geminiDeepThinkDomProvider.reconcilePendingPrompt?.(
        {
          evaluate: geminiEvaluate,
          delay: vi.fn(async () => undefined),
          state: createGeminiDeepThinkDomProviderState({
            geminiConversationId: CONVERSATION_ID,
          }),
        },
        authority,
      ),
    ).resolves.toMatchObject({
      status: "committed",
      verification: {
        verifiedUserTurnId: "prompt-turn",
        verifiedUserMessageId: "prompt-turn",
      },
    });
    expect(chatgptEvaluations).toHaveLength(2);
    expect(geminiEvaluations).toHaveLength(2);
    expect(
      chatgptEvaluations.every((expression) =>
        expression.includes("oracle-pending-prompt-reconciliation"),
      ),
    ).toBe(true);
    expect(
      geminiEvaluations.every(
        (expression) =>
          expression.includes("oracle-gemini-conversation-snapshot") &&
          expression.includes("model-response") &&
          expression.includes("message-content"),
      ),
    ).toBe(true);
  });
});
