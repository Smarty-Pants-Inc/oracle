import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { recoverCommittedGeminiDeepThinkResponse } from "./providers/geminiDeepThinkDomProvider.js";
import type { ReattachCapture } from "./reattachContracts.js";
import { classifyReattachFailure } from "./reattachPlan.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import { withTimeout } from "./reattachHelpers.js";
import type { SessionBoundChromeClient } from "./chromeSessionTransport.js";
import type { BrowserLogger } from "./types.js";
import { delay } from "./utils.js";

export async function captureCommittedGeminiReattach(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  client: SessionBoundChromeClient,
  promptLocator: CommittedPromptEpochLocator,
  targetId: string,
  logger: BrowserLogger,
  warnings?: ReattachCapture["warnings"],
): Promise<ReattachCapture> {
  const { Runtime } = client;
  const timeoutMs = config?.timeoutMs ?? 120_000;
  const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
  await classifyReattachFailure(
    "recoverable-transport",
    `Gemini target ${targetId} did not respond to the reattach probe.`,
    async () =>
      withTimeout(
        Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        pingTimeoutMs,
        "Gemini reattach target did not respond",
      ),
  );
  try {
    const answer = await recoverCommittedGeminiDeepThinkResponse(
      {
        evaluate: async <T>(expression: string): Promise<T | undefined> => {
          const evaluation = await Runtime.evaluate({
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          if (evaluation.exceptionDetails) {
            const detail =
              evaluation.exceptionDetails.exception?.description ??
              evaluation.exceptionDetails.text ??
              "unknown exception";
            throw new Error(`Gemini reattach DOM evaluation failed: ${detail}`);
          }
          return evaluation.result?.value as T | undefined;
        },
        delay,
        log: logger,
      },
      promptLocator,
      timeoutMs,
    );
    return {
      answerText: answer.text,
      answerMarkdown: answer.text,
      runtime,
      ...(warnings ? { warnings } : {}),
    };
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw new BrowserAutomationError(error.message, { ...error.details, runtime }, error);
    }
    throw new BrowserAutomationError(
      error instanceof Error ? error.message : String(error),
      {
        stage: "gemini-response-capture",
        code: "gemini-reattach-capture-pending",
        reattachable: true,
        runtime,
      },
      error,
    );
  }
}
