import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import type { WindowsPrivateTreeAuthority } from "../../src/remote/windowsPrivateTreeAcl.js";

export const testWindowsPrivateTreeAuthority: WindowsPrivateTreeAuthority = async () => {};

export function openTestRemoteTransactionStore(
  options: Parameters<typeof RemoteTransactionStore.open>[0],
) {
  return RemoteTransactionStore.open({
    windowsPrivateTreeAuthority: testWindowsPrivateTreeAuthority,
    ...options,
  });
}
