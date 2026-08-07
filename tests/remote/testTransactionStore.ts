import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { RemoteArtifactStore } from "../../src/remote/artifactStore.js";
import {
  testWindowsPrivateDirectoriesAuthority,
  testWindowsPrivateFileProtectionAuthority,
  testWindowsPrivateFileVerificationAuthority,
  testWindowsPrivateTreeAuthority,
} from "../privateAuthorityTestHelpers.js";
export { testWindowsPrivateTreeAuthority } from "../privateAuthorityTestHelpers.js";

export function openTestRemoteTransactionStore(
  options: Parameters<typeof RemoteTransactionStore.open>[0],
) {
  return RemoteTransactionStore.open({
    windowsPrivateTreeAuthority: testWindowsPrivateTreeAuthority,
    ...options,
  });
}

export function createTestRemoteArtifactStore(
  options: ConstructorParameters<typeof RemoteArtifactStore>[0],
) {
  return new RemoteArtifactStore({
    windowsPrivateDirectoriesAuthority: testWindowsPrivateDirectoriesAuthority,
    windowsPrivateFileProtectionAuthority: testWindowsPrivateFileProtectionAuthority,
    windowsPrivateFileVerificationAuthority: testWindowsPrivateFileVerificationAuthority,
    ...options,
  });
}
