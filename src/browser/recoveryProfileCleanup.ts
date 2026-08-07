import os from "node:os";
import path from "node:path";
import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import {
  assertPrivateDirectoryAuthority,
  assertTemporaryProfileAuthority,
  parseTemporaryProfileAuthority,
  removeTemporaryProfileAuthority,
  type TemporaryProfileAuthority,
} from "../privateTempRoot.js";
import type { RetainedChromeEndpointAuthority } from "./chromeLifecycle.js";
import {
  cleanupStaleProfileState,
  isSafeChromeTerminationOutcome,
  sameProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import {
  cleanupProfileAbsent,
  physicalProfileDirectoryIdentity,
} from "./recoveryCleanupIdentity.js";
import type { ReattachCleanupDeps } from "./reattachCleanupTypes.js";
import { teardownBrowserResourcesIfNoActiveLeases } from "./tabLeaseRegistry.js";
import type { BrowserLogger } from "./types.js";
export interface LocalRecoveryTeardownAuthority {
  endpointAuthority?: RetainedChromeEndpointAuthority;
  recordedProcessExited: boolean;
}

export async function teardownManualLoginRecoveryGroupIfNoActiveLeases(
  resource: BrowserRecoveryCleanupResourceMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  authority: LocalRecoveryTeardownAuthority,
): Promise<string | null> {
  const teardown =
    deps.teardownBrowserResourcesIfNoActiveLeases ?? teardownBrowserResourcesIfNoActiveLeases;
  const profileDir = resource.userDataDir;
  const processIdentity = resource.chromeProcessIdentity;
  const profileDirectory = physicalProfileDirectoryIdentity(processIdentity?.profileDirectory);
  if (!profileDir) return "Cleanup profile path is missing";
  if (!processIdentity) return "Chrome process identity cleanup metadata is missing";
  if (!profileDirectory) return "Chrome physical profile identity cleanup metadata is missing";

  let directError: string | null = null;
  const outcome = await teardown(
    profileDir,
    async () => {
      directError = await teardownLocalRecoveryGroup(resource, logger, deps, authority);
      return directError === null;
    },
    { logger, expectedProfileIdentity: profileDirectory },
  );
  return outcome.status === "completed"
    ? null
    : (directError ??
        outcome.error ??
        `Manual-login cleanup preserved resources (${outcome.reason})`);
}

export async function teardownLocalRecoveryGroup(
  resource: BrowserRecoveryCleanupResourceMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  authority: LocalRecoveryTeardownAuthority,
): Promise<string | null> {
  const profileKind = resource.recoveryCleanup.profileKind;
  const profileDir = resource.userDataDir;
  const temporaryProfileAuthority =
    profileKind === "temporary" || profileKind === "copied"
      ? parseTemporaryProfileAuthority(resource.temporaryProfileAuthority)
      : null;
  const profileError = validateCleanupProfilePath(resource, profileKind, temporaryProfileAuthority);
  if (!profileDir || profileError) return profileError ?? "Cleanup profile path is missing";
  if (temporaryProfileAuthority) {
    try {
      await assertPrivateDirectoryAuthority(temporaryProfileAuthority.generation.parent);
    } catch (error) {
      return `Temporary profile parent authority changed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const processIdentity = resource.chromeProcessIdentity;
  if (!processIdentity && temporaryProfileAuthority && (await cleanupProfileAbsent(profileDir))) {
    return null;
  }
  const profileDirectory =
    temporaryProfileAuthority?.profileDirectory ??
    physicalProfileDirectoryIdentity(
      processIdentity?.profileDirectory ?? resource.profileDirectoryIdentity,
    );
  if (!profileDirectory) {
    return "Chrome physical profile identity cleanup metadata is missing";
  }
  if (
    processIdentity &&
    !sameProfileDirectoryIdentity(processIdentity.profileDirectory, profileDirectory)
  ) {
    return "Chrome process identity does not match the temporary profile authority";
  }
  if (temporaryProfileAuthority) {
    try {
      await assertTemporaryProfileAuthority(temporaryProfileAuthority);
    } catch (error) {
      return `Temporary profile authority changed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (
    !(await (deps.verifyProfileDirectoryIdentity ?? verifyProfileDirectoryIdentity)(
      profileDir,
      profileDirectory,
    ))
  ) {
    return "Chrome process identity does not match the cleanup profile";
  }

  if (processIdentity && !authority.recordedProcessExited) {
    const exactTerminator = deps.terminateExactChromeForProfile;
    const termination = authority.endpointAuthority
      ? await authority.endpointAuthority.kill()
      : exactTerminator
        ? await exactTerminator(profileDir, processIdentity, logger)
        : null;
    if (!termination) {
      return "Exact Chrome endpoint authority is unavailable for process teardown";
    }
    if (!isSafeChromeTerminationOutcome(termination)) {
      if (profileKind === "manual-login") {
        logger(`[browser] Preserving manual-login profile: ${termination.reason}`);
      }
      return termination.reason;
    }
    if (termination.pid !== undefined && termination.pid !== processIdentity.pid) {
      return "Exact Chrome endpoint authority stopped a different process generation";
    }
  } else if (!processIdentity && profileKind === "manual-login") {
    return "Chrome process identity cleanup metadata is missing";
  }

  if (profileKind === "manual-login") {
    const cleanupProfileState = deps.cleanupStaleProfileState ?? cleanupStaleProfileState;
    return (await cleanupProfileState(profileDir, logger, {
      lockRemovalMode: "never",
      expectedProfileIdentity: profileDirectory,
    }))
      ? null
      : `Manual-login profile cleanup was not confirmed: ${profileDir}`;
  }

  if (!temporaryProfileAuthority) {
    return "Exact temporary profile cleanup authority is missing";
  }
  return (await removeCleanupProfile(temporaryProfileAuthority, deps.removeProfile))
    ? null
    : `Profile removal was not confirmed: ${profileDir}`;
}
function validateCleanupProfilePath(
  runtime: BrowserRecoveryCleanupResourceMetadata,
  profileKind: "temporary" | "manual-login" | "copied" | "none",
  temporaryProfileAuthority: TemporaryProfileAuthority | null,
): string | null {
  const profileDir = runtime.userDataDir;
  if (!profileDir) return "Cleanup profile path is missing";
  if (!path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir) {
    return `Cleanup profile path is not canonical and absolute: ${profileDir}`;
  }
  const root = path.parse(profileDir).root;
  if (profileDir === root || profileDir === path.resolve(os.homedir())) {
    return `Refusing unsafe cleanup profile path: ${profileDir}`;
  }
  if (runtime.chromeProfileRoot && runtime.chromeProfileRoot !== profileDir) {
    return "Serialized Chrome profile roots disagree";
  }
  if (profileKind !== "temporary" && profileKind !== "copied") {
    return temporaryProfileAuthority
      ? "Persistent profile cleanup cannot carry temporary-profile authority"
      : null;
  }
  if (!temporaryProfileAuthority) return "Exact temporary profile cleanup authority is missing";
  if (
    temporaryProfileAuthority.profileDirectory.canonicalPath !== profileDir ||
    temporaryProfileAuthority.generation.path !== profileDir
  ) {
    return "Temporary profile path does not match its persisted authority";
  }
  const persistedProfile = physicalProfileDirectoryIdentity(runtime.profileDirectoryIdentity);
  if (runtime.profileDirectoryIdentity !== undefined && !persistedProfile) {
    return "Chrome physical profile identity cleanup metadata is missing";
  }
  if (
    persistedProfile &&
    !sameProfileDirectoryIdentity(persistedProfile, temporaryProfileAuthority.profileDirectory)
  ) {
    return "Temporary profile identity does not match its persisted authority";
  }
  return null;
}

async function removeCleanupProfile(
  authority: TemporaryProfileAuthority,
  removeProfile?: (
    profileDir: string,
    expectedIdentity: ProfileDirectoryIdentity,
  ) => Promise<boolean>,
): Promise<boolean> {
  if (!removeProfile) return await removeTemporaryProfileAuthority(authority);
  try {
    await assertTemporaryProfileAuthority(authority);
  } catch {
    return false;
  }
  return (await removeProfile(authority.generation.path, authority.profileDirectory)) === true;
}
