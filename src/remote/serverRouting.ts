import type http from "node:http";
import type { BrowserLogger } from "../browser/types.js";
import type { resumeBrowserSession } from "../browser/reattach.js";
import type { runBrowserMode, BrowserRunTransaction } from "../browserMode.js";
import { getCliVersion } from "../version.js";
import type { RemoteArtifactStore } from "./artifactStore.js";
import { serveRemoteArtifact, serveRemoteArtifactReceipt } from "./serverArtifacts.js";
import { handleRemoteRunRequest } from "./serverExecution.js";
import {
  authenticateRemoteRequest,
  formatSocket,
  matchArtifactReceiptRequest,
  matchArtifactRequest,
  matchTransactionRequest,
  sendJson,
} from "./serverHttp.js";
import { serveRemoteTransactionSettlement } from "./serverTransactionRuntime.js";
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
  runBrowser: (options: Parameters<typeof runBrowserMode>[0]) => Promise<BrowserRunTransaction>;
  resumeBrowser: typeof resumeBrowserSession;
  logger: (message: string) => void;
  cleanupLogger: BrowserLogger;
  verbose: boolean;
  authToken: string;
  startedAt: number;
  transactionStore: RemoteTransactionStore;
  artifactStore: RemoteArtifactStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  admitControllerOperation: () => (() => void) | null;
  isClosing: () => boolean;
  isBrowserWorkBusy: () => boolean;
  startBrowserWork: () => void;
  finishBrowserWork: () => void;
  runBrowserWork: <T>(operation: () => Promise<T>) => Promise<T>;
  sweepExpiredAuthority: (waitForExisting?: boolean) => Promise<void>;
}

export function attachRemoteRequestRouter(
  server: http.Server,
  deps: RemoteRequestRouterDeps,
): void {
  server.on("request", async (req, res) => {
    let releaseControllerOperation: (() => void) | null = null;
    try {
      if (req.method === "GET" && req.url === "/status") {
        deps.logger("[serve] Health check /status");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        if (
          !authenticateRemoteRequest(req, res, deps.authToken, deps.logger, deps.verbose, "/health")
        ) {
          return;
        }
        sendJson(res, 200, {
          ok: true,
          version: getCliVersion(),
          uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
          capabilities: ARTIFACT_CAPABILITIES,
        });
        return;
      }

      releaseControllerOperation = deps.admitControllerOperation();
      if (!releaseControllerOperation) {
        sendJson(res, 503, { error: "server_closing" });
        return;
      }

      const artifactReceiptMatch = matchArtifactReceiptRequest(req);
      if (artifactReceiptMatch) {
        if (
          !authenticateRemoteRequest(
            req,
            res,
            deps.authToken,
            deps.logger,
            deps.verbose,
            "/transactions/.../artifacts/.../receipt",
          )
        ) {
          return;
        }
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
        await serveRemoteArtifact({
          req,
          res,
          authToken: deps.authToken,
          artifactStore: deps.artifactStore,
          transactionStore: deps.transactionStore,
          logger: deps.logger,
          verbose: deps.verbose,
          transactionToken: artifactMatch.transactionToken,
          artifactId: artifactMatch.artifactId,
        });
        return;
      }

      const transactionMatch = matchTransactionRequest(req);
      if (transactionMatch) {
        if (
          !authenticateRemoteRequest(
            req,
            res,
            deps.authToken,
            deps.logger,
            deps.verbose,
            `/transactions/${transactionMatch.action}`,
          )
        ) {
          return;
        }
        if (transactionMatch.action === "run") {
          await deps.sweepExpiredAuthority(true);
          if (deps.isClosing()) {
            sendJson(res, 503, { error: "server_closing" });
            return;
          }
          if (deps.isBrowserWorkBusy()) {
            if (deps.verbose) {
              deps.logger(
                `[serve] Busy: rejecting new run from ${formatSocket(req)} while another run is active`,
              );
            }
            sendJson(res, 409, { error: "busy" });
            return;
          }
          deps.startBrowserWork();
          try {
            await handleRemoteRunRequest({
              req,
              res,
              options: deps.options,
              runBrowser: deps.runBrowser,
              logger: deps.logger,
              verbose: deps.verbose,
              transactionToken: transactionMatch.transactionToken,
              transactionStore: deps.transactionStore,
              artifactStore: deps.artifactStore,
              transactionCoordinator: deps.transactionCoordinator,
            });
          } finally {
            deps.finishBrowserWork();
          }
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
          runBrowserWork: deps.runBrowserWork,
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
