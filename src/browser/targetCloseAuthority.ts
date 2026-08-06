import { randomUUID } from "node:crypto";
import type {
  BrowserRecoveryCleanupResourceMetadata,
  BrowserRecoveryProfileKind,
  BrowserRecoveryTargetCloseCapabilityMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import type { ExactChromeTargetCleanupResult } from "./chromeTargetConnection.js";
import type { BrowserLogger } from "./types.js";

export type RetainedTargetCloseCapabilityResult =
  | ExactChromeTargetCleanupResult
  | {
      status: "unavailable";
      reason: string;
    };

export function canExactOwnedProcessTeardownSubsumeTargetClose(options: {
  profileKind: BrowserRecoveryProfileKind;
  keepBrowserOpen: boolean;
  hasExactProcessAuthority: boolean;
}): boolean {
  return (
    options.hasExactProcessAuthority &&
    !options.keepBrowserOpen &&
    options.profileKind !== "manual-login" &&
    options.profileKind !== "none"
  );
}
function normalizeExactBrowserWSEndpoint(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const endpoint = new URL(value);
    const port = Number.parseInt(endpoint.port, 10);
    if (
      endpoint.protocol !== "ws:" ||
      !endpoint.hostname ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65_535 ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !/^\/devtools\/browser\/[^/]+$/u.test(endpoint.pathname)
    ) {
      return null;
    }
    return endpoint.toString();
  } catch {
    return null;
  }
}

function hasRestartDurableTargetResourceAuthority(
  resource: BrowserRecoveryCleanupResourceMetadata,
): boolean {
  const cleanup = resource.recoveryCleanup;
  if (
    cleanup.profileKind !== "none" &&
    !cleanup.keepBrowser &&
    !resource.chromeProcessIdentity &&
    !resource.acquisition?.processLaunchClaim
  ) {
    return false;
  }
  if (!cleanup.ownsTarget || cleanup.closeOwnedTargetOnComplete === false) return true;
  if (cleanup.closeOwnedTargetOnComplete !== true) return false;
  return canExactOwnedProcessTeardownSubsumeTargetClose({
    profileKind: cleanup.profileKind,
    keepBrowserOpen: cleanup.keepBrowser,
    hasExactProcessAuthority: Boolean(resource.chromeProcessIdentity),
  });
}

export function hasRestartDurableChromeTargetCleanupAuthority(
  runtime: BrowserRuntimeMetadata,
): boolean {
  const resources = runtime.recoveryCleanupResources ?? [];
  if (resources.length > 0) return resources.every(hasRestartDurableTargetResourceAuthority);
  return !(
    runtime.chromeTargetId ||
    runtime.chromeProcessIdentity ||
    runtime.chromePid ||
    runtime.chromeBrowserWSEndpoint ||
    runtime.chromePort ||
    runtime.chromeProfileRoot ||
    runtime.userDataDir ||
    runtime.recoveryCleanupResult
  );
}

interface RetainedTargetCloseAuthority {
  readonly generationId: string;
  readonly targetId: string;
  readonly close?: (logger: BrowserLogger) => Promise<ExactChromeTargetCleanupResult>;
  readonly release?: () => Promise<void>;
  terminalStatus?: "completed" | "gone";
  terminalAcknowledged?: boolean;
  settlement?: Promise<RetainedTargetCloseCapabilityResult>;
}

const retainedTargetCloseAuthorities = new Map<string, RetainedTargetCloseAuthority>();
const MAX_RETAINED_TERMINAL_TARGET_CLOSE_CAPABILITIES = 128;
const retainedAcknowledgedTerminalTargetCloseCapabilityIds: string[] = [];

function retainTerminalTargetCloseCapability(
  capabilityId: string,
  authority: RetainedTargetCloseAuthority,
  terminalStatus: "completed" | "gone",
  terminalAcknowledged: boolean,
): void {
  retainedTargetCloseAuthorities.set(capabilityId, {
    generationId: authority.generationId,
    targetId: authority.targetId,
    terminalStatus,
    ...(terminalAcknowledged ? { terminalAcknowledged: true } : {}),
  });
  if (!terminalAcknowledged) return;
  retainedAcknowledgedTerminalTargetCloseCapabilityIds.push(capabilityId);
  while (
    retainedAcknowledgedTerminalTargetCloseCapabilityIds.length >
    MAX_RETAINED_TERMINAL_TARGET_CLOSE_CAPABILITIES
  ) {
    retainedTargetCloseAuthorities.delete(
      retainedAcknowledgedTerminalTargetCloseCapabilityIds.shift()!,
    );
  }
}

export function retainChromeTargetCloseCapability(options: {
  generationId: string;
  targetId: string;
  browserWSEndpoint?: string;
  close: (logger: BrowserLogger) => Promise<ExactChromeTargetCleanupResult>;
  release?: () => Promise<void>;
}): BrowserRecoveryTargetCloseCapabilityMetadata {
  const generationId = options.generationId.trim();
  const targetId = options.targetId.trim();
  const browserWSEndpoint = normalizeExactBrowserWSEndpoint(options.browserWSEndpoint);
  if (!generationId || !targetId || (options.browserWSEndpoint && !browserWSEndpoint)) {
    throw new Error(
      "Exact Chrome target close authority requires valid generation, target, and endpoint identity.",
    );
  }
  const capabilityId = randomUUID();
  retainedTargetCloseAuthorities.set(capabilityId, {
    generationId,
    targetId,
    close: options.close,
    release: options.release,
  });
  return Object.freeze({
    version: 1,
    generationId,
    capabilityId,
    targetId,
    ...(browserWSEndpoint ? { browserWSEndpoint } : {}),
  });
}

export function isBrowserRecoveryTargetCloseCapability(
  value: unknown,
): value is BrowserRecoveryTargetCloseCapabilityMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.generationId === "string" &&
    candidate.generationId.trim().length > 0 &&
    typeof candidate.capabilityId === "string" &&
    candidate.capabilityId.trim().length > 0 &&
    (candidate.targetId === undefined ||
      (typeof candidate.targetId === "string" && candidate.targetId.trim().length > 0)) &&
    (candidate.browserWSEndpoint === undefined ||
      (typeof candidate.browserWSEndpoint === "string" &&
        normalizeExactBrowserWSEndpoint(candidate.browserWSEndpoint) ===
          candidate.browserWSEndpoint))
  );
}

export async function closeChromeTargetWithRetainedCapability(options: {
  capability: BrowserRecoveryTargetCloseCapabilityMetadata;
  targetId: string;
  logger: BrowserLogger;
}): Promise<RetainedTargetCloseCapabilityResult> {
  const { capability, targetId, logger } = options;
  if (!isBrowserRecoveryTargetCloseCapability(capability)) {
    return {
      status: "unavailable",
      reason: "Persisted Chrome target close capability is malformed; the target was preserved",
    };
  }
  const authority = retainedTargetCloseAuthorities.get(capability.capabilityId);
  if (!authority) {
    return {
      status: "unavailable",
      reason:
        "Retained exact Chrome target close capability is no longer live (for example after a controller restart); the target was preserved",
    };
  }
  if (
    authority.generationId !== capability.generationId ||
    authority.targetId !== targetId ||
    (capability.targetId !== undefined && capability.targetId !== targetId)
  ) {
    return {
      status: "unavailable",
      reason:
        "Persisted Chrome target close capability does not match this target generation; the target was preserved",
    };
  }
  if (authority.terminalStatus && !authority.release) {
    return { status: authority.terminalStatus };
  }
  const close = authority.close;
  if (!close) {
    return {
      status: "unavailable",
      reason: "Retained exact Chrome target close capability is not live; the target was preserved",
    };
  }
  if (authority.settlement) return authority.settlement;

  authority.settlement = (async () => {
    const closeResult = authority.terminalStatus
      ? ({ status: authority.terminalStatus } as const)
      : await close(logger);
    if (closeResult.status === "unsafe") return closeResult;
    authority.terminalStatus = closeResult.status;
    try {
      await authority.release?.();
    } catch (error) {
      return {
        status: "unsafe" as const,
        reason: `Exact Chrome target close authority release failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (retainedTargetCloseAuthorities.get(capability.capabilityId) === authority) {
      retainTerminalTargetCloseCapability(
        capability.capabilityId,
        authority,
        closeResult.status,
        false,
      );
    }
    return closeResult;
  })();

  try {
    return await authority.settlement;
  } finally {
    if (retainedTargetCloseAuthorities.get(capability.capabilityId) === authority) {
      authority.settlement = undefined;
    }
  }
}

/** Drops a live close capability after durable intentional target preservation. */
export async function discardChromeTargetCloseCapability(options: {
  capability: BrowserRecoveryTargetCloseCapabilityMetadata;
  targetId: string;
}): Promise<void> {
  const { capability, targetId } = options;
  if (!isBrowserRecoveryTargetCloseCapability(capability)) return;
  const authority = retainedTargetCloseAuthorities.get(capability.capabilityId);
  if (
    !authority ||
    authority.generationId !== capability.generationId ||
    authority.targetId !== targetId
  ) {
    return;
  }
  await authority.release?.();
  if (retainedTargetCloseAuthorities.get(capability.capabilityId) === authority) {
    retainedTargetCloseAuthorities.delete(capability.capabilityId);
  }
}

/** Releases a terminal capability only after its exact target cleanup state is durable. */
export function acknowledgeChromeTargetCloseCapability(options: {
  capability: BrowserRecoveryTargetCloseCapabilityMetadata;
  targetId: string;
}): void {
  const { capability, targetId } = options;
  if (!isBrowserRecoveryTargetCloseCapability(capability)) return;
  const authority = retainedTargetCloseAuthorities.get(capability.capabilityId);
  if (
    !authority?.terminalStatus ||
    authority.terminalAcknowledged ||
    authority.close ||
    authority.release ||
    authority.generationId !== capability.generationId ||
    authority.targetId !== targetId
  ) {
    return;
  }
  retainTerminalTargetCloseCapability(
    capability.capabilityId,
    authority,
    authority.terminalStatus,
    true,
  );
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  clearRetainedTargetCloseAuthorities(): void {
    retainedTargetCloseAuthorities.clear();
    retainedAcknowledgedTerminalTargetCloseCapabilityIds.length = 0;
  },
  retainedTargetCloseAuthorityCount(): number {
    return retainedTargetCloseAuthorities.size;
  },
  retainedAcknowledgedTerminalTargetCloseAuthorityCount(): number {
    return retainedAcknowledgedTerminalTargetCloseCapabilityIds.length;
  },
  retainedTerminalTargetCloseCapabilityLimit: MAX_RETAINED_TERMINAL_TARGET_CLOSE_CAPABILITIES,
};
