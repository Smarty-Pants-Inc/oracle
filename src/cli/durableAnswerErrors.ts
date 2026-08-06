import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  readDurableBrowserAnswer,
  type DurableBrowserAnswerReceipt,
} from "./durableBrowserAnswerFile.js";
import { sanitizeBrowserPublicationMessage } from "./browserPublicationJournal.js";

export function durableBrowserAnswerReceiptFromError(
  error: unknown,
): DurableBrowserAnswerReceipt | undefined {
  if (!(error instanceof BrowserAutomationError)) return undefined;
  const receipt = error.details?.answerReceipt;
  if (!receipt || typeof receipt !== "object" || !("artifact" in receipt)) return undefined;
  return receipt as DurableBrowserAnswerReceipt;
}

export async function verifiedDurableBrowserAnswerReceiptFromError(
  error: unknown,
): Promise<DurableBrowserAnswerReceipt | undefined> {
  const receipt = durableBrowserAnswerReceiptFromError(error);
  if (!receipt) return undefined;
  try {
    return (await readDurableBrowserAnswer(receipt)) === null ? undefined : receipt;
  } catch {
    return undefined;
  }
}

export function runtimeFromBrowserError(error: unknown): BrowserRuntimeMetadata | undefined {
  if (!(error instanceof BrowserAutomationError)) return undefined;
  const runtime = error.details?.runtime;
  return typeof runtime === "object" && runtime !== null
    ? (runtime as BrowserRuntimeMetadata)
    : undefined;
}

export function formatBrowserPublicationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeBrowserPublicationMessage(message) || "browser publication failed";
}
