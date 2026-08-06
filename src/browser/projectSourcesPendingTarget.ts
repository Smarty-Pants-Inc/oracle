import type {
  BrowserRecoveryCleanupResourceMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import {
  closeChromeTargetWithExactAuthority,
  listChromeTargetsWithExactAuthority,
} from "./chromeLifecycle.js";
import { bindPersistedLocalEndpoint } from "./pendingProcessAcquisition.js";
import {
  assertProjectSourcesCleanupProof,
  projectSourcesManualLeaseIdentity,
  type ProjectSourcesAuthorityDeps,
  type ProjectSourcesCleanupProof,
  type ProjectSourcesCleanupStorage,
} from "./projectSourcesCleanupAuthority.js";
import { readOracleChromeOwner, sameProfileDirectoryIdentity } from "./profileState.js";
import { hasExactBrowserTabLease, releaseBrowserTabLease } from "./tabLeaseRegistry.js";
import type { BrowserLogger } from "./types.js";

export interface ProjectSourcesPendingTargetDeps extends ProjectSourcesAuthorityDeps {
  releaseBrowserTabLease?: typeof releaseBrowserTabLease;
  bindPersistedLocalEndpoint?: typeof bindPersistedLocalEndpoint;
  listChromeTargetsWithExactAuthority?: typeof listChromeTargetsWithExactAuthority;
  closeChromeTargetWithExactAuthority?: typeof closeChromeTargetWithExactAuthority;
}

function completePendingResource(
  resource: BrowserRecoveryCleanupResourceMetadata,
): BrowserRecoveryCleanupResourceMetadata {
  const acquisition = resource.acquisition;
  if (!acquisition) return resource;
  const { pendingResource: _pendingResource, ...completed } = acquisition;
  return { ...resource, acquisition: completed };
}

function replaceOnlyResource(
  runtime: BrowserRuntimeMetadata,
  resource: BrowserRecoveryCleanupResourceMetadata,
): BrowserRuntimeMetadata {
  return { ...runtime, recoveryCleanupResources: [resource] };
}

export async function reconcilePendingProjectSourcesManualAcquisition(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
  deps: ProjectSourcesPendingTargetDeps = {},
): Promise<{ runtime: BrowserRuntimeMetadata; proof: ProjectSourcesCleanupProof } | null> {
  if (proof.kind !== "manual-login") return { runtime, proof };
  let currentRuntime = runtime;
  let currentProof = proof;
  let resource = currentRuntime.recoveryCleanupResources?.[0];
  if (!resource) return { runtime: currentRuntime, proof: currentProof };

  if (resource.acquisition?.pendingResource === "tab-lease") {
    const active = await (deps.hasExactBrowserTabLease ?? hasExactBrowserTabLease)(
      currentProof.userDataDir,
      projectSourcesManualLeaseIdentity(currentProof),
    );
    if (!active) return null;
    currentProof = {
      ...currentProof,
      lease: { ...currentProof.lease, state: "active" },
    };
    resource = completePendingResource(resource);
    currentRuntime = replaceOnlyResource(currentRuntime, resource);
  }

  if (
    resource.acquisition?.pendingResource !== "chrome-process" ||
    resource.chromeProcessIdentity
  ) {
    return { runtime: currentRuntime, proof: currentProof };
  }
  const active = await (deps.hasExactBrowserTabLease ?? hasExactBrowserTabLease)(
    currentProof.userDataDir,
    projectSourcesManualLeaseIdentity(currentProof),
  );
  const owner = await (deps.readOracleChromeOwner ?? readOracleChromeOwner)(
    currentProof.userDataDir,
  );
  if (!active) {
    if (!owner) return null;
    throw new Error("Project Sources pending manual owner has no exact Project Sources lease.");
  }
  if (!owner) {
    await (deps.releaseBrowserTabLease ?? releaseBrowserTabLease)(
      currentProof.userDataDir,
      projectSourcesManualLeaseIdentity(currentProof),
    );
    return null;
  }
  if (
    !sameProfileDirectoryIdentity(
      owner.processIdentity.profileDirectory,
      currentProof.profileDirectory,
    )
  ) {
    throw new Error("Project Sources pending manual owner profile does not match its exact lease.");
  }
  const acquired = completePendingResource({
    ...resource,
    chromePid: owner.processIdentity.pid,
    chromeProcessIdentity: owner.processIdentity,
    chromePort: owner.port,
    profileDirectoryIdentity: owner.processIdentity.profileDirectory,
    acquisition: {
      ...resource.acquisition,
      processOwnerDisposition: owner.disposition,
    },
    recoveryCleanup: {
      ...resource.recoveryCleanup,
      keepBrowser: owner.disposition === "preserve",
    },
  });
  currentProof = { ...currentProof, owner };
  currentRuntime = {
    ...replaceOnlyResource(currentRuntime, acquired),
    chromePid: owner.processIdentity.pid,
    chromeProcessIdentity: owner.processIdentity,
    chromePort: owner.port,
  };
  return { runtime: currentRuntime, proof: currentProof };
}

function clearPendingTarget(
  runtime: BrowserRuntimeMetadata,
  resource: BrowserRecoveryCleanupResourceMetadata,
): BrowserRuntimeMetadata {
  const cleared = completePendingResource({
    ...resource,
    chromeTargetId: undefined,
    targetCloseCapability: undefined,
    recoveryCleanup: {
      ...resource.recoveryCleanup,
      ownsTarget: false,
      closeOwnedTargetOnComplete: undefined,
    },
  });
  return { ...replaceOnlyResource(runtime, cleared), chromeTargetId: undefined };
}

export async function reconcilePendingProjectSourcesTarget(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  logger: BrowserLogger,
  deps: ProjectSourcesPendingTargetDeps = {},
): Promise<BrowserRuntimeMetadata> {
  const pendingResources = runtime.recoveryCleanupResources?.filter(
    (candidate) => candidate.acquisition?.pendingResource === "chrome-target",
  );
  if (!pendingResources?.length || proof.kind !== "manual-login") return runtime;
  if (pendingResources.length !== 1) {
    throw new Error(
      "Project Sources interrupted target acquisition names multiple pending resources.",
    );
  }
  const resource = pendingResources[0];
  if (!resource || resource.chromeTargetId || resource.targetCloseCapability) return runtime;
  await assertProjectSourcesCleanupProof(runtime, proof, storage, deps);
  const binding = await (deps.bindPersistedLocalEndpoint ?? bindPersistedLocalEndpoint)(resource, {
    readOracleChromeOwner: deps.readOracleChromeOwner,
  });
  if (binding.status === "gone") return clearPendingTarget(runtime, resource);
  try {
    const listed = await (
      deps.listChromeTargetsWithExactAuthority ?? listChromeTargetsWithExactAuthority
    )(binding.authority);
    if (listed.status === "gone") return clearPendingTarget(runtime, resource);
    if (listed.status !== "completed") {
      throw new Error(`Project Sources marker target listing is unsafe: ${listed.reason}`);
    }
    const markerUrl = resource.acquisition?.targetMarkerUrl;
    const matches = listed.value.filter((target) => target.url === markerUrl);
    if (matches.length === 0) return clearPendingTarget(runtime, resource);
    if (matches.length !== 1 || matches[0]?.type !== "page" || !matches[0].targetId) {
      throw new Error("Project Sources marker target authority is ambiguous or mismatched.");
    }
    const closed = await (
      deps.closeChromeTargetWithExactAuthority ?? closeChromeTargetWithExactAuthority
    )({ authority: binding.authority, targetId: matches[0].targetId, logger });
    if (closed.status !== "completed" && closed.status !== "gone") {
      throw new Error(`Project Sources marker target close is unsafe: ${closed.reason}`);
    }
    return clearPendingTarget(runtime, resource);
  } finally {
    await binding.authority.release().catch((error: unknown) => {
      logger(
        `[browser] Failed to release Project Sources recovery endpoint authority: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
