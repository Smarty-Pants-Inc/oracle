import { BrowserAutomationError } from "../oracle/errors.js";
import { REMOTE_TRANSACTION_TOKEN_PATTERN } from "./types.js";

export function isRemoteTransactionToken(value: unknown): value is string {
  return typeof value === "string" && REMOTE_TRANSACTION_TOKEN_PATTERN.test(value);
}

export function assertRemoteTransactionToken(value: unknown): asserts value is string {
  if (isRemoteTransactionToken(value)) return;
  throw new BrowserAutomationError(
    "Remote transaction token must be exactly 64 lowercase hexadecimal characters.",
    { stage: "remote-protocol", code: "invalid-remote-transaction-token" },
  );
}
