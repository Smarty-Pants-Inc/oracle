import { chmod, lstat, mkdir } from "node:fs/promises";
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

const REMOTE_TRANSACTION_HEAD_DIRECTORY_NAME = ".remote-transaction-authority";

export function remoteTransactionHeadDirectory(
  integrityKeyPath: string,
  authorityDirectory?: string,
): string {
  return path.resolve(
    authorityDirectory ??
      path.join(
        path.dirname(path.resolve(integrityKeyPath)),
        REMOTE_TRANSACTION_HEAD_DIRECTORY_NAME,
      ),
  );
}

export interface RemoteTransactionStoreRootOptions {
  directory: string;
  integrityKeyPath: string;
  authorityDirectory?: string;
  platform?: NodeJS.Platform;
  windowsPrivateTreeAuthority?: WindowsPrivateTreeAuthority;
}

export interface RemoteTransactionStoreRootAuthority {
  directory: string;
  platform: NodeJS.Platform;
  storeRootIdentity: PhysicalDirectoryIdentity;
  headDirectory: string;
  headDirectoryIdentity: PhysicalDirectoryIdentity;
  integrityKeyDirectory: string;
  integrityKeyDirectoryIdentity: PhysicalDirectoryIdentity;
}

export async function initializeRemoteTransactionStoreRoot(
  options: RemoteTransactionStoreRootOptions,
): Promise<RemoteTransactionStoreRootAuthority> {
  const platform = options.platform ?? process.platform;
  const directory = path.resolve(options.directory);
  const headDirectory = remoteTransactionHeadDirectory(
    options.integrityKeyPath,
    options.authorityDirectory,
  );
  const integrityKeyPath = path.resolve(options.integrityKeyPath);
  const integrityKeyDirectory = path.dirname(integrityKeyPath);
  if (platform === "win32") {
    await (options.windowsPrivateTreeAuthority ?? protectWindowsPrivateTreeAcl)({
      storeDirectory: directory,
      authorityDirectory: headDirectory,
      integrityKeyDirectory,
      integrityKeyPath,
      initializeRoots: true,
    });
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(headDirectory, { recursive: true, mode: 0o700 });
    await mkdir(integrityKeyDirectory, { recursive: true, mode: 0o700 });
  }
  return {
    directory,
    platform,
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
  const headDirectory = remoteTransactionHeadDirectory(
    options.integrityKeyPath,
    options.authorityDirectory,
  );
  const integrityKeyPath = path.resolve(options.integrityKeyPath);
  const integrityKeyDirectory = path.dirname(integrityKeyPath);
  if (
    authority.directory !== directory ||
    authority.headDirectory !== headDirectory ||
    authority.integrityKeyDirectory !== integrityKeyDirectory
  ) {
    throw new Error("Remote transaction root authority does not match configured paths");
  }
  await assertRemoteTransactionStoreRootGeneration(authority);
  if (platform === "win32") {
    await (options.windowsPrivateTreeAuthority ?? protectWindowsPrivateTreeAcl)({
      storeDirectory: directory,
      authorityDirectory: headDirectory,
      integrityKeyDirectory,
      integrityKeyPath,
    });
  } else {
    await chmod(directory, 0o700);
    await chmod(headDirectory, 0o700);
    if (integrityKeyDirectory !== directory && integrityKeyDirectory !== headDirectory) {
      await chmod(integrityKeyDirectory, 0o700);
    }
  }
  const storeRootIdentity = await capturePhysicalDirectoryIdentity(directory);
  if (!samePhysicalDirectoryIdentity(authority.storeRootIdentity, storeRootIdentity)) {
    throw new Error(
      platform === "win32"
        ? "Remote transaction store root generation changed during Windows private ACL protection"
        : "Remote transaction store root generation changed during private-root protection",
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
  const currentHeadDirectory = await capturePhysicalDirectoryIdentity(headDirectory);
  if (!samePhysicalDirectoryIdentity(authority.headDirectoryIdentity, currentHeadDirectory)) {
    throw new Error(
      platform === "win32"
        ? "Remote transaction head directory generation changed during Windows private ACL protection"
        : "Remote transaction head directory generation changed during private-root protection",
    );
  }
  await assertRemoteTransactionStoreRootAuthority(authority);
  await syncDirectory(directory);
  if (headDirectory !== directory) await syncDirectory(headDirectory);
  if (integrityKeyDirectory !== directory && integrityKeyDirectory !== headDirectory) {
    await syncDirectory(integrityKeyDirectory);
  }
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
  await assertRemoteTransactionStoreRootGeneration(authority);
  if (authority.platform === "win32") return;
  await Promise.all([
    assertPrivateOwnedDirectory(authority.directory, "store root"),
    assertPrivateOwnedDirectory(authority.headDirectory, "authority directory"),
    assertPrivateOwnedDirectory(authority.integrityKeyDirectory, "integrity key directory"),
  ]);
}

async function assertRemoteTransactionStoreRootGeneration(
  authority: RemoteTransactionStoreRootAuthority,
): Promise<void> {
  const currentStoreRoot = await capturePhysicalDirectoryIdentity(authority.directory);
  if (!samePhysicalDirectoryIdentity(currentStoreRoot, authority.storeRootIdentity)) {
    throw new Error("Remote transaction store root generation changed");
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
  const currentHeadDirectory = await capturePhysicalDirectoryIdentity(authority.headDirectory);
  if (!samePhysicalDirectoryIdentity(currentHeadDirectory, authority.headDirectoryIdentity)) {
    throw new Error("Remote transaction head directory generation changed");
  }
}

async function assertPrivateOwnedDirectory(directory: string, label: string): Promise<void> {
  const entry = await lstat(directory, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Remote transaction ${label} is not a physical directory`);
  }
  if ((entry.mode & 0o777n) !== 0o700n) {
    throw new Error(`Remote transaction ${label} permissions must be 0700`);
  }
  const currentUserId = process.geteuid?.() ?? process.getuid?.();
  if (currentUserId !== undefined && entry.uid !== BigInt(currentUserId)) {
    throw new Error(`Remote transaction ${label} must be owned by the controller user`);
  }
}
