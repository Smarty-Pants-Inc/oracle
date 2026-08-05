import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserLogger, BrowserRunOptions, BrowserRunResult } from "./types.js";

export async function persistPreArchiveCapture(
  callback: BrowserRunOptions["preArchiveCaptureCb"],
  result: BrowserRunResult,
  runtime: BrowserRuntimeMetadata,
): Promise<void> {
  if (!callback) return;
  try {
    await callback(structuredClone(result), runtime);
  } catch (cause) {
    throw new BrowserAutomationError(
      "The exact captured answer could not be persisted before conversation archive.",
      {
        stage: "pre-archive-capture-persistence",
        code: "pre-archive-capture-persistence-failed",
      },
      cause,
    );
  }
}

export async function saveOptionalArtifact<T>(
  operation: () => Promise<T | null>,
  logger: BrowserLogger,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Failed to save session artifact: ${message}`);
    return null;
  }
}

export function appendPostCaptureWarning(
  result: BrowserRunResult,
  code: string,
  context: string,
  error: unknown,
  logger: BrowserLogger,
): void {
  const failureMessage = error instanceof Error ? error.message : String(error);
  const failureStage =
    error instanceof BrowserAutomationError && typeof error.details?.stage === "string"
      ? error.details.stage
      : context;
  logger(`[browser] Answer captured; ${context} remains incomplete: ${failureMessage}`);
  result.warnings = [
    ...(result.warnings ?? []),
    {
      code,
      severity: "warning",
      message: `The exact assistant answer was preserved, but ${context} did not complete: ${failureMessage}`,
      details: { stage: failureStage },
    },
  ];
}

export type PostCapturePendingWork = {
  code: string;
  context: string;
};

export function projectRuntimeAfterChromeTargetLoss(
  runtime: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata {
  const projected: BrowserRuntimeMetadata = { ...runtime };
  // Endpoint liveness can disprove the current attachment, but it cannot prove that the recorded
  // target generation was closed. Keep the exact cleanup resource and opaque close capability
  // intact; only clear the non-authoritative top-level selection used for live capture.
  delete projected.chromeTargetId;
  return projected;
}
