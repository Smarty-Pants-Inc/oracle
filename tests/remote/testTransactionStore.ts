import { mkdir, open } from "node:fs/promises";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import type { WindowsPrivateTreeAuthority } from "../../src/remote/windowsPrivateTreeAcl.js";

export const testWindowsPrivateTreeAuthority: WindowsPrivateTreeAuthority = async (scope) => {
  if (scope.initializeRoots) {
    await mkdir(scope.integrityKeyDirectory, { recursive: true });
    await mkdir(scope.storeDirectory, { recursive: true });
    await mkdir(scope.authorityDirectory ?? scope.storeDirectory, { recursive: true });
  }
  const filePath = scope.initializeIntegrityKey ? scope.integrityKeyPath : scope.initializeFilePath;
  if (filePath) {
    const handle = await open(filePath, "wx");
    await handle.close();
  }
};

export function openTestRemoteTransactionStore(
  options: Parameters<typeof RemoteTransactionStore.open>[0],
) {
  return RemoteTransactionStore.open({
    windowsPrivateTreeAuthority: testWindowsPrivateTreeAuthority,
    ...options,
  });
}
