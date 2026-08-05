import type http from "node:http";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionManager.js";
import { terminateChromeWithExactEndpointAuthority } from "../browser/chromeEndpointAuthority.js";
import {
  readOracleChromeOwner,
  sameChromeProcessIdentity,
  type ChromeProcessIdentity,
  type ProfileStateLogger,
  type RecordedChromeTerminationOutcome,
} from "../browser/profileState.js";
import {
  RemoteTransactionConflictError,
  type RemoteTransactionCoordinator,
} from "./transactionCoordinator.js";
import { settlementResponse } from "./transactionProtocol.js";
import { type RemoteTransactionRecord, type RemoteTransactionStore } from "./transactionStore.js";
import { RemoteAbortRequestSchema, RemoteFinalizeRequestSchema } from "./types.js";
import { readRequestBody, sendJson } from "./serverHttp.js";

export async function terminateRemoteChromeWithExactControl(
  runtime: BrowserRuntimeMetadata,
  profileDir: string,
  identity: ChromeProcessIdentity,
  logger?: ProfileStateLogger,
): Promise<RecordedChromeTerminationOutcome> {
  const resource = runtime.recoveryCleanupResources?.find(
    (candidate) =>
      candidate.chromeProcessIdentity &&
      sameChromeProcessIdentity(candidate.chromeProcessIdentity, identity),
  );
  if (!resource) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Durable cleanup resource does not contain the exact Chrome process generation",
    };
  }
  let owner;
  try {
    owner = await readOracleChromeOwner(profileDir);
  } catch (error) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!owner || !sameChromeProcessIdentity(owner.processIdentity, identity)) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Persisted Chrome owner launch nonce or process identity no longer matches",
    };
  }

  const host = resource.chromeHost ?? "127.0.0.1";
  const port = resource.chromePort ?? owner.port;
  if (port !== owner.port) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Durable Chrome control port does not match the persisted owner record",
    };
  }
  const outcome = await terminateChromeWithExactEndpointAuthority({
    host,
    port,
    browserWSEndpoint: resource.chromeBrowserWSEndpoint,
    userDataDir: profileDir,
    processIdentity: identity,
  });

  if (outcome.status === "stopped") {
    logger?.(`Stopped exact Chrome process generation ${identity.pid} through Browser.close`);
  }
  return outcome;
}

export function isAbortWorthyRemoteCaptureMismatch(error: unknown): boolean {
  let code: unknown;
  if (error instanceof BrowserAutomationError) {
    code = error.details?.code;
  } else if (error && typeof error === "object" && "code" in error) {
    code = error.code;
  }
  return (
    code === "committed-prompt-identity-mismatch" ||
    code === "remote-prompt-authority-mismatch" ||
    code === "staged_capture_identity_mismatch"
  );
}

export async function serveRemoteTransactionSettlement(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  transactionToken: string;
  mode: "finalize" | "abort";
  transactionStore: RemoteTransactionStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  runBrowserWork: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<void> {
  const renewed = await renewAuthenticatedTransactionLease(
    params.transactionStore,
    params.transactionToken,
  );
  if (renewed === "expired") {
    sendJson(params.res, 409, { error: "transaction_lease_expired" });
    return;
  }
  if (!renewed) {
    sendJson(params.res, 404, { error: "transaction_not_found" });
    return;
  }
  let durablePublication = false;
  try {
    const raw = await readRequestBody(params.req, 4096);
    const value = raw ? JSON.parse(raw) : {};
    if (params.mode === "finalize") {
      durablePublication = RemoteFinalizeRequestSchema.parse(value).durablePublication;
    } else {
      RemoteAbortRequestSchema.parse(value);
    }
  } catch {
    sendJson(params.res, 400, { error: "invalid_settlement_request" });
    return;
  }

  try {
    const settle = () =>
      params.transactionCoordinator.settle({
        transactionToken: params.transactionToken,
        mode: params.mode,
        durablePublication,
      });
    const outcome =
      renewed.state === "finalized" || renewed.state === "aborted" || renewed.state === "failed"
        ? await settle()
        : await params.runBrowserWork(settle);
    sendJson(params.res, 200, settlementResponse(outcome.record, outcome.finalization));
  } catch (error) {
    if (error instanceof RemoteTransactionConflictError) {
      sendJson(params.res, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes("does not exist")) {
      sendJson(params.res, 404, { error: "transaction_not_found" });
      return;
    }
    throw error;
  }
}

export async function persistRemoteBrowserRuntime(params: {
  transactionStore: RemoteTransactionStore;
  transactionToken: string;
  runtime: BrowserRuntimeMetadata;
  modelSelection?: BrowserModelSelectionEvidence;
}): Promise<void> {
  if (params.runtime.recoveryCleanupResult?.settlementMode) {
    await params.transactionStore.persistSettlementRuntime(params.transactionToken, params.runtime);
    return;
  }
  await params.transactionStore.journalRuntime(
    params.transactionToken,
    params.runtime,
    params.modelSelection,
  );
}

export async function renewAuthenticatedTransactionLease(
  transactionStore: RemoteTransactionStore,
  transactionToken: string,
): Promise<RemoteTransactionRecord | "expired" | null> {
  try {
    return await transactionStore.renewLease(transactionToken);
  } catch (error) {
    const latest = await transactionStore.read(transactionToken);
    if (!latest) return null;
    if (latest.state === "finalized" || latest.state === "aborted" || latest.state === "failed") {
      return latest;
    }
    if (error instanceof Error && error.message.includes("expired remote transaction lease")) {
      return "expired";
    }
    throw error;
  }
}
