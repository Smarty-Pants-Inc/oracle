import { lstat, open, readFile } from "node:fs/promises";
import { syncDirectory } from "../fsDurability.js";
import {
  assertPrivateDirectoryAuthority,
  assertTemporaryProfileAuthority,
} from "../privateTempRoot.js";
import type { WindowsPrivateDirectoryAuthority } from "../windowsPrivateFileAcl.js";
import {
  projectSourcesCleanupOwnerId,
  projectSourcesMarkerFileIdentityFromStats,
  projectSourcesTemporaryMarkerPath,
  sameProjectSourcesMarkerFileIdentity,
  type ProjectSourcesCleanupStorage,
  type ProjectSourcesProfileCreateIntent,
  type ProjectSourcesTemporaryCleanupProof,
} from "./projectSourcesCleanupProof.js";
import {
  captureProfileDirectoryIdentity,
  sameProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";

export interface ProjectSourcesTemporaryMarkerStoreDeps {
  readonly windowsPrivateDirectoryAuthority?: WindowsPrivateDirectoryAuthority;
}

function temporaryMarkerContent(intent: ProjectSourcesProfileCreateIntent): string {
  return `${JSON.stringify({
    version: 1,
    purpose: "project-sources-cleanup",
    storageOwnerId: intent.storageOwnerId,
    generationId: intent.generationId,
    userDataDir: intent.userDataDir,
    token: intent.markerToken,
  })}\n`;
}

function temporaryMarkerContentMatches(
  value: unknown,
  intent: ProjectSourcesProfileCreateIntent,
): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    candidate.purpose === "project-sources-cleanup" &&
    candidate.storageOwnerId === intent.storageOwnerId &&
    candidate.generationId === intent.generationId &&
    candidate.userDataDir === intent.userDataDir &&
    candidate.token === intent.markerToken
  );
}

export async function authenticateProjectSourcesTemporaryMarker(
  intent: ProjectSourcesProfileCreateIntent,
  deps: ProjectSourcesTemporaryMarkerStoreDeps = {},
): Promise<ProjectSourcesTemporaryCleanupProof> {
  if (!intent.temporaryProfileAuthority) {
    throw new Error("Project Sources temporary profile has no exact profile authority.");
  }
  await assertTemporaryProfileAuthority(intent.temporaryProfileAuthority, deps);
  const authorityPath = projectSourcesTemporaryMarkerPath(intent.userDataDir);
  const before = projectSourcesMarkerFileIdentityFromStats(
    await lstat(authorityPath, { bigint: true }),
  );
  const parsed: unknown = JSON.parse(await readFile(authorityPath, "utf8"));
  const after = projectSourcesMarkerFileIdentityFromStats(
    await lstat(authorityPath, { bigint: true }),
  );
  if (
    !sameProjectSourcesMarkerFileIdentity(before, after) ||
    !temporaryMarkerContentMatches(parsed, intent)
  ) {
    throw new Error("Project Sources temporary profile authority marker changed or mismatched.");
  }
  await assertTemporaryProfileAuthority(intent.temporaryProfileAuthority, deps);
  return {
    version: 1,
    kind: "temporary",
    storageOwnerId: intent.storageOwnerId,
    generationId: intent.generationId,
    userDataDir: intent.userDataDir,
    approvedBase: intent.parent,
    temporaryProfileAuthority: intent.temporaryProfileAuthority,
    profileDirectory: intent.temporaryProfileAuthority.profileDirectory,
    marker: { path: authorityPath, token: intent.markerToken, identity: before },
  };
}

export async function createProjectSourcesTemporaryCleanupProof(
  intent: ProjectSourcesProfileCreateIntent,
  storage: ProjectSourcesCleanupStorage,
): Promise<ProjectSourcesTemporaryCleanupProof> {
  await assertProjectSourcesProfileParent(intent, storage);
  const handle = await open(projectSourcesTemporaryMarkerPath(intent.userDataDir), "wx", 0o600);
  try {
    await handle.writeFile(temporaryMarkerContent(intent), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(intent.userDataDir);
  await assertProjectSourcesProfileParent(intent, storage);
  return await authenticateProjectSourcesTemporaryMarker(intent, {
    windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority,
  });
}

async function assertApprovedTemporaryBase(
  expected: ProfileDirectoryIdentity,
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  await assertPrivateDirectoryAuthority(storage.runtimeRoot, {
    windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority,
  });
  if (
    expected.platform !== storage.runtimeRoot.platform ||
    expected.canonicalPath !== storage.runtimeRoot.path ||
    expected.device !== storage.runtimeRoot.identity.device ||
    expected.inode !== storage.runtimeRoot.identity.inode ||
    expected.birthtimeNs !== storage.runtimeRoot.identity.birthtimeNs
  ) {
    throw new Error("Project Sources temporary profile parent is not the private runtime root.");
  }
}

export async function assertProjectSourcesProfileParent(
  intent: ProjectSourcesProfileCreateIntent,
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  if (intent.storageOwnerId !== projectSourcesCleanupOwnerId(storage)) {
    throw new Error("Project Sources profile creation intent has different cleanup storage.");
  }
  await assertApprovedTemporaryBase(intent.parent, storage);
  const current = await captureProfileDirectoryIdentity(intent.parent.canonicalPath);
  if (!sameProfileDirectoryIdentity(current, intent.parent)) {
    throw new Error("Project Sources temporary profile parent authority changed before recovery.");
  }
  if (intent.temporaryProfileAuthority) {
    if (
      intent.temporaryProfileAuthority.generation.path !== intent.userDataDir ||
      intent.temporaryProfileAuthority.generation.parent.path !== intent.parent.canonicalPath
    ) {
      throw new Error("Project Sources private child does not match its creation intent.");
    }
    await assertTemporaryProfileAuthority(intent.temporaryProfileAuthority, {
      windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority,
    });
  }
}

export async function assertProjectSourcesTemporaryProof(
  proof: ProjectSourcesTemporaryCleanupProof,
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  if (proof.storageOwnerId !== projectSourcesCleanupOwnerId(storage)) {
    throw new Error("Project Sources temporary proof has different cleanup storage.");
  }
  await assertApprovedTemporaryBase(proof.approvedBase, storage);
  await assertTemporaryProfileAuthority(proof.temporaryProfileAuthority, {
    windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority,
  });
  const currentProfile = await captureProfileDirectoryIdentity(proof.userDataDir);
  if (
    !sameProfileDirectoryIdentity(currentProfile, proof.temporaryProfileAuthority.profileDirectory)
  ) {
    throw new Error("Project Sources temporary profile physical authority changed.");
  }
  const currentMarker = await authenticateProjectSourcesTemporaryMarker(
    {
      generationId: proof.generationId,
      storageOwnerId: proof.storageOwnerId,
      markerToken: proof.marker.token,
      parent: proof.approvedBase,
      temporaryProfileAuthority: proof.temporaryProfileAuthority,
      userDataDir: proof.userDataDir,
    },
    { windowsPrivateDirectoryAuthority: storage.windowsPrivateDirectoryAuthority },
  );
  if (
    !sameProfileDirectoryIdentity(currentMarker.profileDirectory, proof.profileDirectory) ||
    !sameProjectSourcesMarkerFileIdentity(currentMarker.marker.identity, proof.marker.identity)
  ) {
    throw new Error("Project Sources temporary profile marker physical authority changed.");
  }
}
