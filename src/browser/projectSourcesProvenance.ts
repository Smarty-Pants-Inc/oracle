import path from "node:path";
import { parseTemporaryProfileAuthority } from "../privateTempRoot.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import { sameChromeProcessIdentity } from "./chromeProcessIdentity.js";
import {
  parseChromeProcessLaunchClaim,
  sameChromeProcessLaunchClaim,
} from "./chromeProcessLaunchClaim.js";
import {
  projectSourcesCleanupOwnerId,
  projectSourcesManualLeaseIdentity,
  type ProjectSourcesCleanupProof,
  type ProjectSourcesCleanupStorage,
  type ProjectSourcesManualCleanupProof,
} from "./projectSourcesCleanupProof.js";
import {
  authenticateProjectSourcesManualAdmission,
  sameProjectSourcesManualOwner,
} from "./projectSourcesManualAdmissionStore.js";
import { assertProjectSourcesTemporaryProof } from "./projectSourcesTemporaryMarkerStore.js";
import {
  captureProfileDirectoryIdentity,
  parseProfileDirectoryIdentity,
  readOracleChromeOwner,
  sameProfileDirectoryIdentity,
} from "./profileState.js";
import { hasExactBrowserTabLease } from "./tabLeaseRegistry.js";

export interface ProjectSourcesAuthorityDeps {
  hasExactBrowserTabLease?: typeof hasExactBrowserTabLease;
  readOracleChromeOwner?: typeof readOracleChromeOwner;
}

export function hasProjectSourcesCleanupAuthority(runtime: BrowserRuntimeMetadata): boolean {
  return Boolean(runtime.recoveryCleanupResources?.length && runtime.recoveryCleanupResult);
}

export function hasOwnedProjectSourcesProvenance(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
): boolean {
  const resources = runtime.recoveryCleanupResources;
  if (!resources || resources.length !== 1) return false;
  if (runtime.userDataDir && path.resolve(runtime.userDataDir) !== proof.userDataDir) return false;
  return resources.every((resource) => {
    const acquisition = resource.acquisition;
    const launchClaim = parseChromeProcessLaunchClaim(acquisition?.processLaunchClaim);
    const profile = parseProfileDirectoryIdentity(
      resource.profileDirectoryIdentity,
      process.platform,
    );
    const temporaryProfileAuthority = parseTemporaryProfileAuthority(
      resource.temporaryProfileAuthority,
      process.platform,
    );
    const disposition = acquisition?.processOwnerDisposition;
    if (
      !acquisition ||
      acquisition.generationId !== proof.generationId ||
      !launchClaim ||
      launchClaim.generationId !== proof.generationId ||
      !disposition ||
      !profile ||
      !sameProfileDirectoryIdentity(profile, proof.profileDirectory) ||
      resource.userDataDir !== proof.userDataDir ||
      resource.chromeProfileRoot !== proof.userDataDir ||
      acquisition.targetMarkerUrl !== `about:blank#oracle-project-sources=${proof.generationId}` ||
      (proof.kind === "temporary" &&
        (resource.recoveryCleanup.profileKind !== "temporary" ||
          acquisition.processOwnerProvenance !== "temporary-launch" ||
          !temporaryProfileAuthority ||
          temporaryProfileAuthority.generation.platform !==
            proof.temporaryProfileAuthority.generation.platform ||
          temporaryProfileAuthority.generation.path !==
            proof.temporaryProfileAuthority.generation.path ||
          temporaryProfileAuthority.generation.identity.device !==
            proof.temporaryProfileAuthority.generation.identity.device ||
          temporaryProfileAuthority.generation.identity.inode !==
            proof.temporaryProfileAuthority.generation.identity.inode ||
          temporaryProfileAuthority.generation.identity.birthtimeNs !==
            proof.temporaryProfileAuthority.generation.identity.birthtimeNs ||
          temporaryProfileAuthority.generation.parent.path !==
            proof.temporaryProfileAuthority.generation.parent.path ||
          temporaryProfileAuthority.generation.parent.identity.device !==
            proof.temporaryProfileAuthority.generation.parent.identity.device ||
          temporaryProfileAuthority.generation.parent.identity.inode !==
            proof.temporaryProfileAuthority.generation.parent.identity.inode ||
          temporaryProfileAuthority.generation.parent.identity.birthtimeNs !==
            proof.temporaryProfileAuthority.generation.parent.identity.birthtimeNs ||
          !sameProfileDirectoryIdentity(
            temporaryProfileAuthority.profileDirectory,
            proof.profileDirectory,
          ))) ||
      (proof.kind === "manual-login" &&
        (resource.recoveryCleanup.profileKind !== "manual-login" ||
          acquisition.processOwnerProvenance !== "manual-canonical-owner" ||
          resource.temporaryProfileAuthority !== undefined))
    ) {
      return false;
    }
    if (
      resource.chromeProcessIdentity &&
      (!sameProfileDirectoryIdentity(resource.chromeProcessIdentity.profileDirectory, profile) ||
        (proof.kind === "temporary" &&
          !sameChromeProcessLaunchClaim(resource.chromeProcessIdentity.launchClaim, launchClaim)))
    ) {
      return false;
    }
    if (proof.kind === "manual-login") {
      const lease = resource.tabLease;
      if (proof.lease.state === "released") {
        if (lease) return false;
      } else if (
        !lease ||
        lease.id !== proof.lease.id ||
        lease.generationId !== proof.generationId ||
        !sameProfileDirectoryIdentity(lease.profileDirectory, proof.profileDirectory)
      ) {
        return false;
      }
      if (proof.lease.state === "pending" && acquisition.pendingResource !== "tab-lease") {
        return false;
      }
      if (
        resource.chromeProcessIdentity &&
        (!proof.authenticated ||
          !proof.owner ||
          !proof.admission.identity ||
          !sameChromeProcessIdentity(resource.chromeProcessIdentity, proof.owner.processIdentity) ||
          disposition !== proof.owner.disposition)
      ) {
        return false;
      }
    }
    if (acquisition.pendingResource || !resource.recoveryCleanup.ownsTarget) return true;
    return Boolean(
      typeof resource.recoveryCleanup.closeOwnedTargetOnComplete === "boolean" &&
      resource.chromeTargetId &&
      resource.targetCloseCapability?.generationId === proof.generationId &&
      resource.targetCloseCapability.capabilityId,
    );
  });
}

async function assertManualProof(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesManualCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  deps: ProjectSourcesAuthorityDeps,
): Promise<void> {
  if (proof.storageOwnerId !== projectSourcesCleanupOwnerId(storage)) {
    throw new Error("Project Sources manual proof has different cleanup storage.");
  }
  const currentProfile = await captureProfileDirectoryIdentity(proof.userDataDir);
  if (!sameProfileDirectoryIdentity(currentProfile, proof.profileDirectory)) {
    throw new Error("Project Sources manual profile physical authority changed.");
  }
  const requiresOwnedEffects = (runtime.recoveryCleanupResources ?? []).some(
    (resource) =>
      Boolean(resource.chromeProcessIdentity) ||
      resource.recoveryCleanup.ownsTarget ||
      resource.acquisition?.pendingResource === "chrome-target",
  );
  if (requiresOwnedEffects && (!proof.authenticated || !proof.owner || !proof.admission.identity)) {
    throw new Error(
      "Project Sources manual cleanup has no authenticated lease/owner admission receipt.",
    );
  }
  if (proof.authenticated && proof.owner && proof.admission.identity) {
    await authenticateProjectSourcesManualAdmission(proof, storage, proof.owner);
  }
  if (proof.lease.state === "pending") {
    throw new Error("Project Sources manual lease acquisition is still unresolved.");
  }
  if (proof.lease.state === "active") {
    const hasLease = await (deps.hasExactBrowserTabLease ?? hasExactBrowserTabLease)(
      proof.userDataDir,
      projectSourcesManualLeaseIdentity(proof),
    );
    if (!hasLease) {
      throw new Error("Project Sources manual cleanup exact lease evidence is unavailable.");
    }
    if (proof.owner) {
      const owner = await (deps.readOracleChromeOwner ?? readOracleChromeOwner)(proof.userDataDir);
      if (!owner || !sameProjectSourcesManualOwner(owner, proof.owner)) {
        throw new Error("Project Sources manual cleanup owner-registry evidence changed.");
      }
    }
  }
}

export async function assertProjectSourcesCleanupProof(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  deps: ProjectSourcesAuthorityDeps = {},
): Promise<void> {
  if (!hasOwnedProjectSourcesProvenance(runtime, proof)) {
    throw new Error("Project Sources cleanup runtime does not match its exact durable proof.");
  }
  if (proof.kind === "temporary") await assertProjectSourcesTemporaryProof(proof, storage);
  else await assertManualProof(runtime, proof, storage, deps);
}

export async function persistProjectSourcesCleanupProofTransition(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  deps: ProjectSourcesAuthorityDeps = {},
): Promise<ProjectSourcesCleanupProof> {
  if (!hasProjectSourcesCleanupAuthority(runtime)) return proof;
  if (proof.kind === "temporary") {
    await assertProjectSourcesTemporaryProof(proof, storage);
    return proof;
  }
  const resource = runtime.recoveryCleanupResources?.[0];
  if (!resource) return proof;
  let next = proof;
  if (
    next.lease.state === "pending" &&
    resource.tabLease &&
    resource.acquisition?.pendingResource !== "tab-lease"
  ) {
    const active = await (deps.hasExactBrowserTabLease ?? hasExactBrowserTabLease)(
      next.userDataDir,
      projectSourcesManualLeaseIdentity(next),
    );
    if (!active) throw new Error("Project Sources manual lease acquisition was not recorded.");
    next = { ...next, lease: { ...next.lease, state: "active" } };
  }
  if (resource.chromeProcessIdentity) {
    const owner =
      next.owner ?? (await (deps.readOracleChromeOwner ?? readOracleChromeOwner)(next.userDataDir));
    if (
      !owner ||
      !sameChromeProcessIdentity(owner.processIdentity, resource.chromeProcessIdentity) ||
      !sameProfileDirectoryIdentity(
        owner.processIdentity.profileDirectory,
        next.profileDirectory,
      ) ||
      owner.disposition !== resource.acquisition?.processOwnerDisposition
    ) {
      throw new Error("Project Sources manual owner-registry evidence does not match acquisition.");
    }
    if (!next.authenticated) {
      if (next.lease.state !== "active") {
        throw new Error("Project Sources manual owner appeared without an active exact lease.");
      }
      const active = await (deps.hasExactBrowserTabLease ?? hasExactBrowserTabLease)(
        next.userDataDir,
        projectSourcesManualLeaseIdentity(next),
      );
      if (!active) throw new Error("Project Sources manual admission has no active exact lease.");
      next = await authenticateProjectSourcesManualAdmission({ ...next, owner }, storage, owner, {
        create: true,
      });
    } else {
      next = await authenticateProjectSourcesManualAdmission(next, storage, owner);
    }
  }
  if (next.lease.state === "active" && !resource.tabLease) {
    next = { ...next, lease: { ...next.lease, state: "released" } };
  }
  if (!hasOwnedProjectSourcesProvenance(runtime, next)) {
    throw new Error("Project Sources cleanup persistence would break its exact proof binding.");
  }
  return next;
}
