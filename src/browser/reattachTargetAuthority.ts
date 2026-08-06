import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import {
  retainChromeEndpointAuthority,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import { inspectChromeProcessIdentity, sameChromeProcessIdentity } from "./profileState.js";
import { isBrowserRecoveryTargetCloseCapability } from "./targetCloseAuthority.js";

interface RefreshAttachRuntimeDeps {
  readActivePort?: typeof readDevToolsActivePortInfo;
  inspectProcessIdentity?: typeof inspectChromeProcessIdentity;
  retainEndpointAuthority?: (options: {
    host: string;
    port: number;
    browserWSEndpoint?: string;
    userDataDir: string;
    processIdentity: NonNullable<BrowserRuntimeMetadata["chromeProcessIdentity"]>;
  }) => Promise<RetainedChromeEndpointAuthority>;
}

function hasExactOwnedTargetGeneration(
  resource: BrowserRecoveryCleanupResourceMetadata,
  targetId: string,
): boolean {
  const acquisitionGenerationId = resource.acquisition?.generationId;
  const capability = resource.targetCloseCapability;
  return (
    resource.recoveryCleanup.ownsTarget === true &&
    resource.chromeTargetId === targetId &&
    Boolean(acquisitionGenerationId) &&
    isBrowserRecoveryTargetCloseCapability(capability) &&
    capability.generationId === acquisitionGenerationId
  );
}

/**
 * Bind the target used for answer capture without rewriting cleanup-resource identity. An explicit
 * target is an attachment choice, not a transfer of ownership.
 */
export function bindReattachTarget(
  runtime: BrowserRuntimeMetadata,
  targetId: string,
): BrowserRuntimeMetadata {
  return runtime.chromeTargetId === targetId ? runtime : { ...runtime, chromeTargetId: targetId };
}

export async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
  deps: RefreshAttachRuntimeDeps = {},
): Promise<BrowserRuntimeMetadata | null> {
  const recordedEndpoint = runtime.chromeBrowserWSEndpoint
    ? new URL(runtime.chromeBrowserWSEndpoint)
    : null;
  const host = runtime.chromeHost ?? recordedEndpoint?.hostname ?? "127.0.0.1";
  const normalizedHost = host.toLowerCase();
  const localHost =
    normalizedHost === "localhost" ||
    normalizedHost === "localhost." ||
    normalizedHost.startsWith("127.") ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]";
  const profileRoot = runtime.chromeProfileRoot ?? runtime.userDataDir;
  if (!profileRoot) {
    if (localHost)
      throw new Error("Recorded local Chrome endpoint has no physical profile authority");
    return runtime;
  }

  const processIdentity = runtime.chromeProcessIdentity;
  if (!processIdentity)
    throw new Error("Recorded local Chrome endpoint has no exact process identity");
  const inspection = await (deps.inspectProcessIdentity ?? inspectChromeProcessIdentity)(
    profileRoot,
    processIdentity,
  );
  if (inspection === "exited") return null;
  if (inspection !== "current") {
    throw new Error("Recorded local Chrome process generation could not be authenticated");
  }

  const activePort = await (deps.readActivePort ?? readDevToolsActivePortInfo)(profileRoot, {
    host,
  });
  const browserWSEndpoint =
    activePort?.browserWSEndpoint ?? runtime.chromeBrowserWSEndpoint ?? undefined;
  const endpointPort = browserWSEndpoint
    ? Number.parseInt(new URL(browserWSEndpoint).port, 10)
    : undefined;
  const port = activePort?.port ?? runtime.chromePort ?? endpointPort;
  if (!port) throw new Error("Recorded local Chrome endpoint has no valid DevTools port");

  const authority = await (deps.retainEndpointAuthority ?? retainChromeEndpointAuthority)({
    host,
    port,
    browserWSEndpoint,
    userDataDir: profileRoot,
    processIdentity,
  });
  try {
    const recoveryCleanupResources = runtime.recoveryCleanupResources?.map((resource) => {
      const sameProcessGeneration = Boolean(
        resource.chromeProcessIdentity &&
        sameChromeProcessIdentity(resource.chromeProcessIdentity, processIdentity),
      );
      const ownedTargetGenerationProven =
        resource.recoveryCleanup.ownsTarget !== true ||
        Boolean(
          resource.chromeTargetId &&
          hasExactOwnedTargetGeneration(resource, resource.chromeTargetId),
        );
      if (resource.remoteRecovery || !sameProcessGeneration || !ownedTargetGenerationProven) {
        return resource;
      }
      return {
        ...resource,
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: authority.browserWSEndpoint,
      };
    });
    return {
      ...runtime,
      chromeHost: host,
      chromePort: port,
      chromeBrowserWSEndpoint: authority.browserWSEndpoint,
      recoveryCleanupResources,
    };
  } finally {
    await authority.release();
  }
}
