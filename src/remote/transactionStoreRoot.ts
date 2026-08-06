import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  capturePhysicalDirectoryIdentity,
  samePhysicalDirectoryIdentity,
  type PhysicalDirectoryIdentity,
} from "../browser/filesystemLockDirectoryIdentity.js";
import { syncDirectory } from "../fsDurability.js";
import {
  protectWindowsPrivateTreeAcl,
  type WindowsPrivateTreeAuthority,
} from "./windowsPrivateTreeAcl.js";

const REMOTE_TRANSACTION_HEAD_DIRECTORY_NAME = ".authenticated-heads";

export function remoteTransactionHeadDirectory(directory: string): string {
  return path.join(path.resolve(directory), REMOTE_TRANSACTION_HEAD_DIRECTORY_NAME);
}

export interface RemoteTransactionStoreRootOptions {
  directory: string;
  integrityKeyPath: string;
  platform?: NodeJS.Platform;
  windowsPrivateTreeAuthority?: WindowsPrivateTreeAuthority;
}

export interface RemoteTransactionStoreRootAuthority {
  directory: string;
  storeRootIdentity: PhysicalDirectoryIdentity;
  headDirectory: string;
  headDirectoryIdentity: PhysicalDirectoryIdentity;
  integrityKeyDirectory: string;
  integrityKeyDirectoryIdentity: PhysicalDirectoryIdentity;
}

export async function initializeRemoteTransactionStoreRoot(
  options: RemoteTransactionStoreRootOptions,
): Promise<RemoteTransactionStoreRootAuthority> {
  const directory = path.resolve(options.directory);
  const headDirectory = remoteTransactionHeadDirectory(directory);
  const integrityKeyDirectory = path.dirname(path.resolve(options.integrityKeyPath));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(headDirectory, { recursive: true, mode: 0o700 });
  await mkdir(integrityKeyDirectory, { recursive: true, mode: 0o700 });
  return {
    directory,
    storeRootIdentity: await capturePhysicalDirectoryIdentity(directory),
    headDirectory,
    headDirectoryIdentity: await capturePhysicalDirectoryIdentity(headDirectory),
    integrityKeyDirectory,
    integrityKeyDirectoryIdentity: await capturePhysicalDirectoryIdentity(integrityKeyDirectory),
  };
}

export async function protectRemoteTransactionStoreRoot(
  options: RemoteTransactionStoreRootOptions,
  authority: RemoteTransactionStoreRootAuthority,
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const directory = path.resolve(options.directory);
  const headDirectory = remoteTransactionHeadDirectory(directory);
  const integrityKeyPath = path.resolve(options.integrityKeyPath);
  const integrityKeyDirectory = path.dirname(integrityKeyPath);
  if (
    authority.directory !== directory ||
    authority.headDirectory !== headDirectory ||
    authority.integrityKeyDirectory !== integrityKeyDirectory
  ) {
    throw new Error("Remote transaction root authority does not match configured paths");
  }
  await assertRemoteTransactionStoreRootAuthority(authority);
  if (platform === "win32") {
    await (options.windowsPrivateTreeAuthority ?? protectWindowsPrivateTreeAcl)({
      storeDirectory: directory,
      integrityKeyDirectory,
      integrityKeyPath,
    });
  } else {
    await chmod(directory, 0o700);
    await chmod(headDirectory, 0o700);
    if (integrityKeyDirectory !== directory) await chmod(integrityKeyDirectory, 0o700);
  }
  const storeRootIdentity = await capturePhysicalDirectoryIdentity(directory);
  if (!samePhysicalDirectoryIdentity(authority.storeRootIdentity, storeRootIdentity)) {
    throw new Error(
      platform === "win32"
        ? "Remote transaction store root generation changed during Windows private ACL protection"
        : "Remote transaction store root generation changed during private-root protection",
    );
  }
  const currentHeadDirectory = await capturePhysicalDirectoryIdentity(headDirectory);
  if (!samePhysicalDirectoryIdentity(authority.headDirectoryIdentity, currentHeadDirectory)) {
    throw new Error(
      platform === "win32"
        ? "Remote transaction head directory generation changed during Windows private ACL protection"
        : "Remote transaction head directory generation changed during private-root protection",
    );
  }
  const integrityKeyDirectoryIdentity =
    await capturePhysicalDirectoryIdentity(integrityKeyDirectory);
  if (
    !samePhysicalDirectoryIdentity(
      authority.integrityKeyDirectoryIdentity,
      integrityKeyDirectoryIdentity,
    )
  ) {
    throw new Error(
      platform === "win32"
        ? "Remote transaction integrity key directory generation changed during Windows private ACL protection"
        : "Remote transaction integrity key directory generation changed during private-root protection",
    );
  }
  await syncDirectory(directory);
  await syncDirectory(headDirectory);
  if (integrityKeyDirectory !== directory) await syncDirectory(integrityKeyDirectory);
}

export async function prepareRemoteTransactionStoreRoot(
  options: RemoteTransactionStoreRootOptions,
): Promise<RemoteTransactionStoreRootAuthority> {
  const authority = await initializeRemoteTransactionStoreRoot(options);
  await protectRemoteTransactionStoreRoot(options, authority);
  return authority;
}

export async function assertRemoteTransactionStoreRootAuthority(
  authority: RemoteTransactionStoreRootAuthority,
): Promise<void> {
  const currentStoreRoot = await capturePhysicalDirectoryIdentity(authority.directory);
  if (!samePhysicalDirectoryIdentity(currentStoreRoot, authority.storeRootIdentity)) {
    throw new Error("Remote transaction store root generation changed");
  }
  const currentHeadDirectory = await capturePhysicalDirectoryIdentity(authority.headDirectory);
  if (!samePhysicalDirectoryIdentity(currentHeadDirectory, authority.headDirectoryIdentity)) {
    throw new Error("Remote transaction head directory generation changed");
  }
  const currentIntegrityKeyDirectory = await capturePhysicalDirectoryIdentity(
    authority.integrityKeyDirectory,
  );
  if (
    !samePhysicalDirectoryIdentity(
      currentIntegrityKeyDirectory,
      authority.integrityKeyDirectoryIdentity,
    )
  ) {
    throw new Error("Remote transaction integrity key directory generation changed");
  }
}
