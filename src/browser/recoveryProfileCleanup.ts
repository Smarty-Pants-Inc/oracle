import os from "node:os";
import path from "node:path";
import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import type { RetainedChromeEndpointAuthority } from "./chromeLifecycle.js";
import {
  cleanupStaleProfileState,
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
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
  const profileError = validateCleanupProfilePath(resource, profileKind);
  if (!profileDir || profileError) return profileError ?? "Cleanup profile path is missing";

  const processIdentity = resource.chromeProcessIdentity;
  if (
    !processIdentity &&
    (profileKind === "temporary" || profileKind === "copied") &&
    (await cleanupProfileAbsent(profileDir))
  ) {
    return null;
  }
  const profileDirectory = physicalProfileDirectoryIdentity(
    processIdentity?.profileDirectory ?? resource.profileDirectoryIdentity,
  );
  if (!profileDirectory) {
    return "Chrome physical profile identity cleanup metadata is missing";
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

  return (await removeCleanupProfile(profileDir, profileDirectory, deps.removeProfile))
    ? null
    : `Profile removal was not confirmed: ${profileDir}`;
}
function validateCleanupProfilePath(
  runtime: BrowserRuntimeMetadata,
  profileKind: "temporary" | "manual-login" | "copied" | "none",
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
  if (
    runtime.chromeProfileRoot &&
    path.resolve(runtime.chromeProfileRoot) !== path.resolve(profileDir)
  ) {
    return "Serialized Chrome profile roots disagree";
  }
  if (profileKind !== "temporary" && profileKind !== "copied") return null;
  const basename = path.basename(profileDir);
  if (!basename.startsWith("oracle-browser-") && !basename.startsWith("oracle-reattach-")) {
    return `Refusing unrecognized temporary profile path: ${profileDir}`;
  }
  const allowedRoots = [
    os.tmpdir(),
    "/tmp",
    "/mnt/c/Users/Public/AppData/Local/Temp",
    "/mnt/c/Temp",
    "/mnt/c/Windows/Temp",
  ].map((candidate) => path.resolve(candidate));
  if (!allowedRoots.some((candidate) => isPathWithin(candidate, profileDir))) {
    return `Temporary profile is outside approved runtime roots: ${profileDir}`;
  }
  return null;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeCleanupProfile(
  profileDir: string,
  expectedIdentity: ProfileDirectoryIdentity,
  removeProfile?: (profileDir: string) => Promise<boolean>,
): Promise<boolean> {
  if (removeProfile) {
    return (await removeProfile(profileDir)) === true;
  }
  return removeProfileDirectoryIfIdentityMatches(profileDir, expectedIdentity);
}
