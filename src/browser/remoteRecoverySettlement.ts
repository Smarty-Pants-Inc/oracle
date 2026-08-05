import { createHash } from "node:crypto";
import { loadUserConfig } from "../config.js";
import { settleRemoteBrowserRecovery } from "../remote/client.js";
import { resolveRemoteServiceConfig } from "../remote/remoteServiceConfig.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import type {
  ReattachCleanupDeps,
  ReattachSettlementMode,
  RecoveryCleanupGroup,
  RecoveryCleanupPhaseResult,
} from "./reattachCleanupTypes.js";
import type { BrowserCaptureFinalizationResult } from "./types.js";
export async function finalizeRemoteRecoveryCleanupGroup(
  group: RecoveryCleanupGroup,
  deps: ReattachCleanupDeps,
  mode: ReattachSettlementMode,
): Promise<RecoveryCleanupPhaseResult> {
  const representative = group.entries[group.entries.length - 1];
  if (!representative) return { pending: [], errors: [] };
  const authority = representative.resource.remoteRecovery;
  const groupLabel = createHash("sha256").update(group.key).digest("hex").slice(0, 12);
  const pending = (error: string, remoteRecovery = authority) => ({
    pending: group.entries.map((entry) => ({
      ...entry,
      resource: {
        ...entry.resource,
        remoteRecovery,
      },
    })),
    errors: [`Cleanup group ${groupLabel}: ${error}`],
  });
  if (!authority) {
    return pending("Remote cleanup transaction authority is missing.");
  }
  if (mode === "finalize" && deps.isRemotePublicationAcknowledged?.() !== true) {
    return pending("Remote settlement requires durable answer publication acknowledgment.");
  }

  let configured: { host?: string; token?: string };
  try {
    if (deps.resolveRemoteRecoveryConfig) {
      configured = await deps.resolveRemoteRecoveryConfig();
    } else {
      const { config: userConfig } = await loadUserConfig({ includeProject: false });
      configured = resolveRemoteServiceConfig({ userConfig, env: process.env });
    }
  } catch (error) {
    return pending(
      `Remote cleanup configuration is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const resource = representative.resource;
  const remoteResources = group.entries.map((entry) => ({
    ...entry.resource,
    remoteRecovery: authority,
  }));
  const runtime: BrowserRuntimeMetadata = {
    chromePid: resource.chromePid,
    chromeProcessIdentity: resource.chromeProcessIdentity,
    chromePort: resource.chromePort,
    chromeHost: resource.chromeHost,
    chromeBrowserWSEndpoint: resource.chromeBrowserWSEndpoint,
    chromeProfileRoot: resource.chromeProfileRoot,
    userDataDir: resource.userDataDir,
    chromeTargetId: resource.chromeTargetId,
    conversationId: resource.conversationId,
    promptEpoch: resource.promptEpoch,
    recoveryCleanupResources: remoteResources,
    recoveryCleanupResult: { status: "pending", settlementMode: mode },
  };
  let result: BrowserCaptureFinalizationResult;
  try {
    result = await (deps.settleRemoteBrowserRecovery ?? settleRemoteBrowserRecovery)({
      runtime,
      configuredHost: configured.host ?? "",
      authToken: configured.token,
      mode,
    });
  } catch (error) {
    return pending(
      `Remote cleanup settlement remains retryable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status === "completed") return { pending: [], errors: [] };
  const returnedAuthority = result.runtime.recoveryCleanupResources?.find(
    (candidate) => candidate.remoteRecovery,
  )?.remoteRecovery;
  return pending(
    result.error || "Remote cleanup settlement remains pending.",
    returnedAuthority ?? authority,
  );
}
