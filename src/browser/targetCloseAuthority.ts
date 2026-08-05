import { randomUUID } from "node:crypto";
import type { BrowserRecoveryTargetCloseCapabilityMetadata } from "../sessionManager.js";
import type { ExactChromeTargetCleanupResult } from "./chromeTargetConnection.js";
import type { BrowserLogger } from "./types.js";

export type RetainedTargetCloseCapabilityResult =
  | ExactChromeTargetCleanupResult
  | {
      status: "unavailable";
      reason: string;
    };

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
  close: (logger: BrowserLogger) => Promise<ExactChromeTargetCleanupResult>;
  release?: () => Promise<void>;
}): BrowserRecoveryTargetCloseCapabilityMetadata {
  const generationId = options.generationId.trim();
  const targetId = options.targetId.trim();
  if (!generationId || !targetId) {
    throw new Error("Exact Chrome target close authority requires generation and target identity.");
  }
  const capabilityId = randomUUID();
  retainedTargetCloseAuthorities.set(capabilityId, {
    generationId,
    targetId,
    close: options.close,
    release: options.release,
  });
  return Object.freeze({ version: 1, generationId, capabilityId });
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
    candidate.capabilityId.trim().length > 0
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
  if (authority.generationId !== capability.generationId || authority.targetId !== targetId) {
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
