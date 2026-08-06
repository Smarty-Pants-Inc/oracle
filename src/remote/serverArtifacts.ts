import type http from "node:http";
import { pipeline } from "node:stream/promises";
import { sanitizeArtifactFilename, sanitizeArtifactMimeType } from "../browser/artifacts.js";
import { RemoteArtifactStore, RemoteArtifactUnavailableError } from "./artifactStore.js";
import type { RemoteTransactionStore } from "./transactionStore.js";
import {
  RemoteArtifactDeliveryReceiptRequestSchema,
  RemoteArtifactManualCopyWaiverRequestSchema,
  type RemoteArtifactDeliveryReceiptRequest,
  type RemoteArtifactManualCopyWaiverRequest,
} from "./types.js";
import { readRequestBody, RemoteRequestError, sendJson } from "./serverHttp.js";
import { renewAuthenticatedTransactionLease } from "./serverTransactionRuntime.js";

export async function serveRemoteArtifact(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  artifactStore: RemoteArtifactStore;
  logger: (message: string) => void;
  transactionStore: RemoteTransactionStore;
  transactionToken: string;
  artifactId: string;
}): Promise<void> {
  try {
    await readRequestBody(params.req, 0);
  } catch (error) {
    if (!(error instanceof RemoteRequestError)) throw error;
    sendJson(params.res, error.statusCode, { error: error.code, message: error.message });
    return;
  }

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

  let opened;
  try {
    opened = await params.artifactStore.openForDelivery(params.transactionToken, params.artifactId);
  } catch (error) {
    if (error instanceof RemoteArtifactUnavailableError) {
      sendJson(params.res, 410, { error: error.code });
      return;
    }
    throw error;
  }
  if (!opened) {
    sendJson(params.res, 404, { error: "artifact_not_found" });
    return;
  }

  const { handle, registration } = opened;
  try {
    const fileStat = await handle.stat();
    const descriptor = registration.descriptor;
    const filename = sanitizeArtifactFilename(descriptor.filename, "artifact.bin");
    params.res.writeHead(200, {
      "Content-Type": sanitizeArtifactMimeType(descriptor.mimeType) ?? "application/octet-stream",
      "Content-Length": fileStat.size,
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Oracle-Artifact-Id": descriptor.artifactId,
      "X-Oracle-Artifact-Sha256": descriptor.sha256,
    });
    await pipeline(handle.createReadStream({ start: 0, autoClose: false }), params.res).catch(
      () => {
        params.logger(`[serve] Artifact transfer failed for ${descriptor.artifactId}.`);
      },
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function serveRemoteArtifactReceipt(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  artifactStore: RemoteArtifactStore;
  transactionStore: RemoteTransactionStore;
  transactionToken: string;
  artifactId: string;
}): Promise<void> {
  let body: RemoteArtifactDeliveryReceiptRequest;
  try {
    const raw = await readRequestBody(params.req, 4096);
    body = RemoteArtifactDeliveryReceiptRequestSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    sendJson(params.res, 400, { error: "invalid_artifact_delivery_receipt" });
    return;
  }
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
  try {
    const receipt = await params.artifactStore.recordDeliveryReceipt({
      transactionToken: params.transactionToken,
      artifactId: params.artifactId,
      sha256: body.sha256,
      byteSize: body.byteSize,
    });
    sendJson(params.res, 200, {
      ok: true,
      artifactId: params.artifactId,
      deliveredAt: receipt.deliveredAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = message.includes("does not exist");
    sendJson(params.res, missing ? 404 : 409, {
      error: missing ? "artifact_not_found" : "artifact_delivery_receipt_conflict",
      message,
    });
  }
}

export async function serveRemoteArtifactManualCopyWaiver(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  artifactStore: RemoteArtifactStore;
  transactionStore: RemoteTransactionStore;
  transactionToken: string;
  artifactId: string;
}): Promise<void> {
  let body: RemoteArtifactManualCopyWaiverRequest;
  try {
    const raw = await readRequestBody(params.req, 4096);
    body = RemoteArtifactManualCopyWaiverRequestSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    sendJson(params.res, 400, { error: "invalid_artifact_manual_copy_waiver" });
    return;
  }
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
  try {
    const waiver = await params.artifactStore.recordManualCopyWaiver({
      transactionToken: params.transactionToken,
      artifactId: params.artifactId,
      sha256: body.sha256,
      byteSize: body.byteSize,
    });
    sendJson(params.res, 200, {
      ok: true,
      artifactId: params.artifactId,
      disposition: waiver?.disposition ?? "delivered",
      ...(waiver ? { waivedAt: waiver.waivedAt } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = message.includes("does not exist");
    sendJson(params.res, missing ? 404 : 409, {
      error: missing ? "artifact_not_found" : "artifact_manual_copy_waiver_conflict",
      message,
    });
  }
}
