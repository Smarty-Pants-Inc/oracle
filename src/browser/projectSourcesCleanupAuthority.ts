import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  type ProjectSourcesCleanupProof,
  type ProjectSourcesCleanupStorage,
} from "./projectSourcesCleanupProof.js";
import {
  manualAdmissionPreparationPath,
  removeProjectSourcesManualAdmission,
} from "./projectSourcesManualAdmissionStore.js";
import {
  persistProjectSourcesCleanupProofTransition,
  type ProjectSourcesAuthorityDeps,
} from "./projectSourcesProvenance.js";

export {
  createProjectSourcesManualCleanupProof,
  createProjectSourcesProfileCreateIntent,
  isProjectSourcesProfileCreateIntent,
  parseProjectSourcesCleanupProof,
  projectSourcesCleanupOwnerId,
  projectSourcesManualLeaseIdentity,
  type ProjectSourcesCleanupProof,
  type ProjectSourcesCleanupStorage,
  type ProjectSourcesManualCleanupProof,
  type ProjectSourcesMarkerFileIdentity,
  type ProjectSourcesProfileCreateIntent,
  type ProjectSourcesTemporaryCleanupProof,
} from "./projectSourcesCleanupProof.js";
export {
  authenticateProjectSourcesManualAdmission,
  sameProjectSourcesManualOwner,
  type ProjectSourcesManualAdmissionOptions,
} from "./projectSourcesManualAdmissionStore.js";
export {
  assertProjectSourcesCleanupProof,
  hasOwnedProjectSourcesProvenance,
  hasProjectSourcesCleanupAuthority,
  type ProjectSourcesAuthorityDeps,
} from "./projectSourcesProvenance.js";
export {
  assertProjectSourcesProfileParent,
  assertProjectSourcesTemporaryProof,
  authenticateProjectSourcesTemporaryMarker,
  createProjectSourcesTemporaryCleanupProof,
  type ProjectSourcesTemporaryMarkerStoreDeps,
} from "./projectSourcesTemporaryMarkerStore.js";
export interface PersistProjectSourcesCleanupProofTransition {
  readonly type: "persist";
  readonly runtime: BrowserRuntimeMetadata;
}

export interface RemoveProjectSourcesCleanupProofArtifactsTransition {
  readonly type: "remove-artifacts";
}

export type ProjectSourcesCleanupProofTransition =
  | PersistProjectSourcesCleanupProofTransition
  | RemoveProjectSourcesCleanupProofArtifactsTransition;

export function transitionProjectSourcesCleanupProof(
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  transition: PersistProjectSourcesCleanupProofTransition,
  deps?: ProjectSourcesAuthorityDeps,
): Promise<ProjectSourcesCleanupProof>;
export function transitionProjectSourcesCleanupProof(
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  transition: RemoveProjectSourcesCleanupProofArtifactsTransition,
  deps?: ProjectSourcesAuthorityDeps,
): Promise<void>;
export function transitionProjectSourcesCleanupProof(
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  transition: ProjectSourcesCleanupProofTransition,
  deps?: ProjectSourcesAuthorityDeps,
): Promise<ProjectSourcesCleanupProof | void>;
export async function transitionProjectSourcesCleanupProof(
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  transition: ProjectSourcesCleanupProofTransition,
  deps: ProjectSourcesAuthorityDeps = {},
): Promise<ProjectSourcesCleanupProof | void> {
  if (transition.type === "persist") {
    return await persistProjectSourcesCleanupProofTransition(
      transition.runtime,
      proof,
      storage,
      deps,
    );
  }
  await removeProjectSourcesManualAdmission(proof, storage);
}

export const __test__ = { manualAdmissionPreparationPath };
