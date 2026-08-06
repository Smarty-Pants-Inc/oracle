import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { BrowserLogger, BrowserRunTransaction } from "../browser/types.js";
import type { resumeBrowserSession } from "../browser/reattach.js";
import type { runBrowserModeTransaction } from "../browser/browserCoordinator.js";
import { getCliVersion } from "../version.js";
import {
  REMOTE_HEALTH_CLIENT_NONCE_HEADER,
  REMOTE_PROTOCOL_HEADER,
  REMOTE_REQUEST_PROOF_HEADER,
  REMOTE_SERVER_GENERATION_HEADER,
  createRemoteHealthAuthenticationProof,
  type RemoteRequestAuthenticator,
} from "./auth.js";
import type { RemoteArtifactStore } from "./artifactStore.js";
import { serveRemoteArtifact, serveRemoteArtifactReceipt } from "./serverArtifacts.js";
import { handleRemoteRunRequest } from "./serverExecution.js";
import {
  authenticateCurrentRemoteRequest,
  authenticateLegacyRemoteRequest,
  formatSocket,
  matchArtifactReceiptRequest,
  matchArtifactRequest,
  matchLegacyRunRequest,
  matchTransactionRequest,
  sendJson,
} from "./serverHttp.js";
import {
  serveRemoteTransactionBinding,
  serveRemoteTransactionSettlement,
} from "./serverTransactionRuntime.js";
import type { RemoteServerOptions } from "./serverTypes.js";
import type { RemoteTransactionCoordinator } from "./transactionCoordinator.js";
import { serveRemoteTransactionRetry } from "./transactionRetryRoute.js";
import type { RemoteTransactionStore } from "./transactionStore.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteArtifactCapabilities,
} from "./types.js";

const ARTIFACT_PROTOCOL_VERSION = 1;

const ARTIFACT_CAPABILITIES: RemoteArtifactCapabilities = {
  artifactTransfer: true,
  artifactProtocolVersion: ARTIFACT_PROTOCOL_VERSION,
  transactionProtocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
  maxArtifactBytes: MAX_REMOTE_ARTIFACT_BYTES,
  maxRequestBytes: MAX_REMOTE_REQUEST_BYTES,
  maxAttachmentBytes: MAX_REMOTE_ATTACHMENT_BYTES,
  maxTotalAttachmentBytes: MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  maxAttachments: MAX_REMOTE_ATTACHMENTS,
  maxPromptChars: MAX_REMOTE_PROMPT_CHARS,
  transportSecurity: "loopback-http",
  boundedRequestDeadlines: true,
  boundedTransactionStore: true,
};

export interface RemoteRequestRouterDeps {
  options: RemoteServerOptions;
  runBrowser: (
    options: Parameters<typeof runBrowserModeTransaction>[0],
  ) => Promise<BrowserRunTransaction>;
  resumeBrowser: typeof resumeBrowserSession;
  logger: (message: string) => void;
  cleanupLogger: BrowserLogger;
  verbose: boolean;
  authToken: string;
  legacyToken?: string;
  controllerGeneration: string;
  requestAuthenticator: RemoteRequestAuthenticator;
  startedAt: number;
  artifactStore: RemoteArtifactStore;
  transactionStore: RemoteTransactionStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  admitControllerOperation: () => (() => void) | null;
  admitRemoteTransaction: (transactionToken: string) => (() => void) | null;
  isRemoteTransactionAdmitted: (transactionToken: string) => boolean;
  isClosing: () => boolean;
  isBrowserWorkBusy: () => boolean;
  isBrowserWorkExclusive: () => boolean;
  startBrowserWork: (mode?: "shared-run" | "exclusive") => () => void;
  runBrowserWork: <T>(operation: () => Promise<T>) => Promise<T>;
  queueBrowserSettlement: <T>(operation: () => Promise<T>) => Promise<T>;
  sweepExpiredAuthority: (waitForExisting?: boolean) => Promise<void>;
}

export function attachRemoteRequestRouter(
  server: http.Server,
  deps: RemoteRequestRouterDeps,
): void {
  server.on("checkContinue", (req, res) => {
    const authentication = deps.requestAuthenticator.authenticate(req);
    if ("statusCode" in authentication) {
      sendJson(res, authentication.statusCode, { error: authentication.code });
      return;
    }
    // Node suppresses a 103 Early Hints response unless it contains Link.
    res.writeEarlyHints({
      link: "</health>; rel=preconnect",
      [REMOTE_SERVER_GENERATION_HEADER]: authentication.serverGeneration,
      [REMOTE_REQUEST_PROOF_HEADER]: authentication.requestProof,
    });
    res.writeContinue();
    server.emit("request", req, res);
  });

  server.on("request", async (req, res) => {
    let releaseControllerOperation: (() => void) | null = null;
    try {
      if (req.method === "GET" && req.url === "/status") {
        deps.logger("[serve] Health check /status");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        const protocol = String(req.headers[REMOTE_PROTOCOL_HEADER] ?? "");
        const clientNonce = String(req.headers[REMOTE_HEALTH_CLIENT_NONCE_HEADER] ?? "");
        if (protocol === String(REMOTE_TRANSACTION_PROTOCOL_VERSION)) {
          if (!/^[a-f0-9]{64}$/u.test(clientNonce)) {
            sendJson(res, 400, { error: "invalid_health_challenge" });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            version: getCliVersion(),
            uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
            capabilities: ARTIFACT_CAPABILITIES,
            authentication: createRemoteHealthAuthenticationProof({
              rootKey: deps.authToken,
              serverGeneration: deps.controllerGeneration,
              clientNonce,
            }),
          });
          return;
        }
        if (
          !authenticateLegacyRemoteRequest(
            req,
            res,
            deps.legacyToken,
            deps.logger,
            deps.verbose,
            "/health",
          )
        ) {
          return;
        }
        sendJson(res, 200, {
          ok: true,
          version: getCliVersion(),
          uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
        });
        return;
      }

      releaseControllerOperation = deps.admitControllerOperation();
      if (!releaseControllerOperation) {
        sendJson(res, 503, { error: "server_closing" });
        return;
      }

      if (matchLegacyRunRequest(req)) {
        if (
          !authenticateLegacyRemoteRequest(
            req,
            res,
            deps.legacyToken,
            deps.logger,
            deps.verbose,
            "/runs",
          )
        ) {
          return;
        }
        await deps.sweepExpiredAuthority(true);
        if (deps.isClosing()) {
          sendJson(res, 503, { error: "server_closing" });
          return;
        }
        if (deps.isBrowserWorkBusy()) {
          sendJson(res, 409, { error: "busy" });
          return;
        }
        const finishBrowserWork = deps.startBrowserWork();
        try {
          await handleRemoteRunRequest({
            req,
            res,
            protocol: "legacy-text-v1",
            options: deps.options,
            runBrowser: deps.runBrowser,
            logger: deps.logger,
            verbose: deps.verbose,
            transactionToken: randomBytes(32).toString("hex"),
            transactionStore: deps.transactionStore,
            artifactStore: deps.artifactStore,
            transactionCoordinator: deps.transactionCoordinator,
          });
        } finally {
          finishBrowserWork();
        }
        return;
      }

      const artifactReceiptMatch = matchArtifactReceiptRequest(req);
      if (artifactReceiptMatch) {
        if (!authenticateCurrentRemoteRequest(req, res, deps.requestAuthenticator)) return;
        await serveRemoteArtifactReceipt({
          req,
          res,
          artifactStore: deps.artifactStore,
          transactionStore: deps.transactionStore,
          transactionToken: artifactReceiptMatch.transactionToken,
          artifactId: artifactReceiptMatch.artifactId,
        });
        return;
      }

      const artifactMatch = matchArtifactRequest(req);
      if (artifactMatch) {
        if (!authenticateCurrentRemoteRequest(req, res, deps.requestAuthenticator)) return;
        await serveRemoteArtifact({
          req,
          res,
          artifactStore: deps.artifactStore,
          transactionStore: deps.transactionStore,
          transactionToken: artifactMatch.transactionToken,
          artifactId: artifactMatch.artifactId,
          logger: deps.logger,
        });
        return;
      }

      const transactionMatch = matchTransactionRequest(req);
      if (transactionMatch) {
        if (!authenticateCurrentRemoteRequest(req, res, deps.requestAuthenticator)) return;
        if (transactionMatch.action === "run") {
          const releaseTransactionAdmission = deps.admitRemoteTransaction(
            transactionMatch.transactionToken,
          );
          if (!releaseTransactionAdmission) {
            sendJson(res, 409, {
              error: "transaction_exists",
              state: "running",
              transactionToken: transactionMatch.transactionToken,
            });
            return;
          }
          try {
            await deps.sweepExpiredAuthority(true);
            if (deps.isClosing()) {
              sendJson(res, 503, { error: "server_closing" });
              return;
            }
            if (deps.isBrowserWorkExclusive()) {
              if (deps.verbose) {
                deps.logger(
                  `[serve] Busy: rejecting new run from ${formatSocket(req)} while exclusive browser work is active`,
                );
              }
              sendJson(res, 409, { error: "busy" });
              return;
            }
            const finishBrowserWork = deps.startBrowserWork("shared-run");
            try {
              await handleRemoteRunRequest({
                req,
                res,
                options: deps.options,
                protocol: "transaction-v3",
                runBrowser: deps.runBrowser,
                logger: deps.logger,
                verbose: deps.verbose,
                transactionToken: transactionMatch.transactionToken,
                transactionStore: deps.transactionStore,
                artifactStore: deps.artifactStore,
                transactionCoordinator: deps.transactionCoordinator,
                releaseTransactionAdmission,
              });
            } finally {
              finishBrowserWork();
            }
          } finally {
            releaseTransactionAdmission();
          }
          return;
        }
        if (transactionMatch.action === "bind") {
          await serveRemoteTransactionBinding({
            req,
            res,
            transactionToken: transactionMatch.transactionToken,
            transactionStore: deps.transactionStore,
            transactionCoordinator: deps.transactionCoordinator,
          });
          return;
        }
        if (transactionMatch.action === "retry") {
          await serveRemoteTransactionRetry({
            req,
            res,
            transactionStore: deps.transactionStore,
            artifactStore: deps.artifactStore,
            transactionCoordinator: deps.transactionCoordinator,
            transactionToken: transactionMatch.transactionToken,
            resumeBrowser: deps.resumeBrowser,
            runBrowserWork: deps.runBrowserWork,
            logger: deps.cleanupLogger,
            serverLogger: deps.logger,
            isTransactionAdmitted: deps.isRemoteTransactionAdmitted,
          });
          return;
        }
        await serveRemoteTransactionSettlement({
          req,
          res,
          transactionToken: transactionMatch.transactionToken,
          mode: transactionMatch.action,
          transactionStore: deps.transactionStore,
          transactionCoordinator: deps.transactionCoordinator,
          runSettlementWork: deps.queueBrowserSettlement,
        });
        return;
      }

      res.statusCode = 404;
      res.end();
    } catch (error) {
      deps.logger(
        `[serve] Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      } else if (!res.destroyed) {
        res.end();
      }
    } finally {
      releaseControllerOperation?.();
    }
  });
}
