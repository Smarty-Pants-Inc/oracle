import { AsyncLocalStorage } from "node:async_hooks";
import { lstat } from "node:fs/promises";
import {
  assertRemoteTransactionStoreRootAuthority,
  type RemoteTransactionStoreRootAuthority,
} from "./transactionStoreRoot.js";
import {
  assertProtectedIntegrityKeyFile,
  readStableRemoteTransactionIntegrityKey,
  sameFileGeneration,
  samePhysicalFile,
  type RemoteTransactionIntegrityKey,
} from "./transactionRecordStorage.js";
import type {
  WindowsPrivateTreeAuthority,
  WindowsPrivateTreeScope,
} from "./windowsPrivateTreeAcl.js";

type RemoteTransactionStoreAuthorityOptions = {
  rootAuthority: RemoteTransactionStoreRootAuthority;
  integrityKey: RemoteTransactionIntegrityKey;
  platform: NodeJS.Platform;
  windowsPrivateTreeAuthority: WindowsPrivateTreeAuthority | undefined;
};

export class RemoteTransactionStoreAuthority {
  readonly #options: RemoteTransactionStoreAuthorityOptions;
  readonly #windowsPrivateTreeScope: WindowsPrivateTreeScope;
  readonly #windowsAuthorityContext = new AsyncLocalStorage<boolean>();
  #windowsAuthorityLock: Promise<void> = Promise.resolve();

  constructor(options: RemoteTransactionStoreAuthorityOptions) {
    this.#options = options;
    this.#windowsPrivateTreeScope = {
      authorityDirectory: options.rootAuthority.headDirectory,
      storeDirectory: options.rootAuthority.directory,
      integrityKeyDirectory: options.integrityKey.directory,
      integrityKeyPath: options.integrityKey.path,
    };
  }

  async assertIntegrity(): Promise<void> {
    await this.assertDirectory();
    const currentKey = await lstat(this.#options.integrityKey.path, { bigint: true });
    assertProtectedIntegrityKeyFile(currentKey, this.#options.platform);
    if (!samePhysicalFile(currentKey, this.#options.integrityKey.fileIdentity)) {
      throw new Error("Remote transaction integrity key generation changed");
    }
  }

  async initializeWindowsPrivateFile(filePath: string): Promise<void> {
    const authority = this.#options.windowsPrivateTreeAuthority;
    if (!authority) {
      throw new Error("Windows private transaction file authority is unavailable");
    }
    await authority({ ...this.#windowsPrivateTreeScope, initializeFilePath: filePath });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const authority = this.#options.windowsPrivateTreeAuthority;
    if (!authority || this.#windowsAuthorityContext.getStore()) return await operation();

    const prior = this.#windowsAuthorityLock;
    const gate = Promise.withResolvers<void>();
    this.#windowsAuthorityLock = prior.then(() => gate.promise);
    await prior;
    try {
      await this.assertDirectory();
      const beforeProtection = await this.readIntegrityKey();
      await this.assertDirectory();
      this.assertWindowsIntegrityKeySnapshot(beforeProtection, "before");

      await authority(this.#windowsPrivateTreeScope);

      await this.assertDirectory();
      const afterProtection = await this.readIntegrityKey();
      this.assertWindowsIntegrityKeySnapshot(afterProtection, "during");
      await this.assertIntegrity();
      return await this.#windowsAuthorityContext.run(true, operation);
    } finally {
      gate.resolve();
    }
  }

  private async assertDirectory(): Promise<void> {
    await assertRemoteTransactionStoreRootAuthority(this.#options.rootAuthority);
  }

  private async readIntegrityKey(): Promise<RemoteTransactionIntegrityKey> {
    const integrityKey = this.#options.integrityKey;
    return await readStableRemoteTransactionIntegrityKey(
      integrityKey.path,
      integrityKey.directory,
      integrityKey.directoryIdentity,
      this.#options.platform,
    );
  }

  // Windows ACL protection must not mutate the integrity key's identity, metadata, or bytes.
  private assertWindowsIntegrityKeySnapshot(
    current: RemoteTransactionIntegrityKey,
    phase: "before" | "during",
  ): void {
    const integrityKey = this.#options.integrityKey;
    const expectedIdentity = integrityKey.fileIdentity;
    if (!sameFileGeneration(current.fileIdentity, expectedIdentity)) {
      throw new Error(
        `Remote transaction integrity key generation changed ${phase} Windows private ACL protection`,
      );
    }
    if (
      current.fileIdentity.ctimeNs !== expectedIdentity.ctimeNs ||
      current.fileIdentity.mtimeNs !== expectedIdentity.mtimeNs ||
      current.fileIdentity.size !== expectedIdentity.size ||
      current.fileIdentity.mode !== expectedIdentity.mode ||
      current.fileIdentity.nlink !== expectedIdentity.nlink
    ) {
      throw new Error(
        `Remote transaction integrity key metadata changed ${phase} Windows private ACL protection`,
      );
    }
    if (!current.bytes.equals(integrityKey.bytes)) {
      throw new Error(
        `Remote transaction integrity key contents changed ${phase} Windows private ACL protection`,
      );
    }
  }
}
