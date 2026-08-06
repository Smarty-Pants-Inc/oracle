import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  capturePhysicalDirectoryIdentity,
  physicalDirectoryIdentityFromStats,
  samePhysicalDirectoryIdentity,
  type PhysicalDirectoryIdentity,
} from "./browser/filesystemLockDirectoryIdentity.js";
import {
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
} from "./browser/filesystemLockDirectoryRemoval.js";
import { establishWindowsPrivateDirectory } from "./remote/windowsPrivateTreeAcl.js";

const PRIVATE_TEMP_ROOT_NAME = "oracle-private";

export interface PrivateDirectoryAuthority {
  readonly path: string;
  readonly identity: PhysicalDirectoryIdentity;
  readonly platform: NodeJS.Platform;
}

export interface PrivateTempGeneration extends PrivateDirectoryAuthority {
  readonly parent: PrivateDirectoryAuthority;
}

export type WindowsPrivateDirectoryAuthority = (directoryPath: string) => Promise<void>;

export interface PrivateTempRootOptions {
  readonly platform?: NodeJS.Platform;
  readonly tempDirectory?: string;
  readonly randomId?: () => string;
  readonly windowsPrivateDirectoryAuthority?: WindowsPrivateDirectoryAuthority;
}

function validatePrefix(prefix: string): void {
  if (!prefix || path.basename(prefix) !== prefix || prefix === "." || prefix === "..") {
    throw new Error("Private temporary generation prefix must be a non-empty basename");
  }
}

async function assertPosixPrivateDirectory(
  authority: Pick<PrivateDirectoryAuthority, "path" | "identity">,
): Promise<void> {
  const entry = await lstat(authority.path, { bigint: true });
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (entry.mode & 0o777n) !== 0o700n ||
    !samePhysicalDirectoryIdentity(
      {
        device: entry.dev.toString(),
        inode: entry.ino.toString(),
        birthtimeNs: entry.birthtimeNs.toString(),
      },
      authority.identity,
    )
  ) {
    throw new Error(`Private temporary directory authority changed: ${authority.path}`);
  }
  const currentUserId = process.geteuid?.() ?? process.getuid?.();
  if (currentUserId !== undefined && entry.uid !== BigInt(currentUserId)) {
    throw new Error(
      `Private temporary directory is not owned by the current user: ${authority.path}`,
    );
  }
}
async function protectPosixPrivateDirectory(
  directoryPath: string,
): Promise<PhysicalDirectoryIdentity> {
  const expected = await capturePhysicalDirectoryIdentity(directoryPath);
  const handle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const openedIdentity = physicalDirectoryIdentityFromStats(opened);
    const currentUserId = process.geteuid?.() ?? process.getuid?.();
    if (
      !opened.isDirectory() ||
      opened.isSymbolicLink() ||
      !samePhysicalDirectoryIdentity(openedIdentity, expected) ||
      (currentUserId !== undefined && opened.uid !== BigInt(currentUserId))
    ) {
      throw new Error(`Private temporary directory cannot be protected: ${directoryPath}`);
    }
    await handle.chmod(0o700);
    const protectedEntry = await handle.stat({ bigint: true });
    if (
      (protectedEntry.mode & 0o777n) !== 0o700n ||
      !samePhysicalDirectoryIdentity(physicalDirectoryIdentityFromStats(protectedEntry), expected)
    ) {
      throw new Error(`Private temporary directory cannot be protected: ${directoryPath}`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  const verified = await capturePhysicalDirectoryIdentity(directoryPath);
  if (!samePhysicalDirectoryIdentity(verified, expected)) {
    throw new Error(`Private temporary directory authority changed: ${directoryPath}`);
  }
  return expected;
}
async function assertPhysicalDirectoryAuthority(
  authority: Pick<PrivateDirectoryAuthority, "path" | "identity">,
): Promise<void> {
  const current = await capturePhysicalDirectoryIdentity(authority.path);
  if (!samePhysicalDirectoryIdentity(current, authority.identity)) {
    throw new Error(`Private temporary directory authority changed: ${authority.path}`);
  }
}

export async function assertPrivateDirectoryAuthority(
  authority: PrivateDirectoryAuthority,
  options: Pick<PrivateTempRootOptions, "windowsPrivateDirectoryAuthority"> = {},
): Promise<void> {
  await assertPhysicalDirectoryAuthority(authority);
  if (authority.platform === "win32") {
    await (options.windowsPrivateDirectoryAuthority ?? establishWindowsPrivateDirectory)(
      authority.path,
    );
    await assertPhysicalDirectoryAuthority(authority);
    return;
  }
  await assertPosixPrivateDirectory(authority);
}

async function establishPrivateRoot(
  options: PrivateTempRootOptions,
): Promise<PrivateDirectoryAuthority> {
  const platform = options.platform ?? process.platform;
  const rootPath = path.join(
    path.resolve(options.tempDirectory ?? tmpdir()),
    PRIVATE_TEMP_ROOT_NAME,
  );
  let identity: PhysicalDirectoryIdentity;
  if (platform === "win32") {
    await (options.windowsPrivateDirectoryAuthority ?? establishWindowsPrivateDirectory)(rootPath);
    identity = await capturePhysicalDirectoryIdentity(rootPath);
  } else {
    try {
      await mkdir(rootPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    identity = await protectPosixPrivateDirectory(rootPath);
  }
  const authority = Object.freeze({
    path: rootPath,
    identity,
    platform,
  });
  return authority;
}

export async function createPrivateTempChildGeneration(
  parent: PrivateDirectoryAuthority,
  prefix: string,
  options: PrivateTempRootOptions = {},
): Promise<PrivateTempGeneration> {
  validatePrefix(prefix);
  if ((options.platform ?? parent.platform) !== parent.platform) {
    throw new Error("Private temporary child platform does not match its parent authority");
  }
  await assertPrivateDirectoryAuthority(parent, options);
  let generationPath: string;
  let identity: PhysicalDirectoryIdentity;
  if (parent.platform === "win32") {
    generationPath = path.join(parent.path, `${prefix}${(options.randomId ?? randomUUID)()}`);
    await (options.windowsPrivateDirectoryAuthority ?? establishWindowsPrivateDirectory)(
      generationPath,
    );
    identity = await capturePhysicalDirectoryIdentity(generationPath);
  } else {
    generationPath = await mkdtemp(path.join(parent.path, prefix));
    identity = await protectPosixPrivateDirectory(generationPath);
  }
  const generation = Object.freeze({
    parent,
    path: generationPath,
    identity,
    platform: parent.platform,
  });
  if (parent.platform === "win32") {
    await assertPhysicalDirectoryAuthority(parent);
    await assertPhysicalDirectoryAuthority(generation);
  } else {
    await assertPrivateTempGeneration(generation, options);
  }
  return generation;
}
export async function assertPrivateTempGeneration(
  generation: PrivateTempGeneration,
  options: Pick<PrivateTempRootOptions, "windowsPrivateDirectoryAuthority"> = {},
): Promise<void> {
  await assertPrivateDirectoryAuthority(generation.parent, options);
  await assertPrivateDirectoryAuthority(generation, options);
}

export async function createPrivateTempGeneration(
  prefix: string,
  options: PrivateTempRootOptions = {},
): Promise<PrivateTempGeneration> {
  const root = await establishPrivateRoot(options);
  return await createPrivateTempChildGeneration(root, prefix, options);
}

export async function removePrivateTempGeneration(
  generation: PrivateTempGeneration,
  options: Pick<PrivateTempRootOptions, "windowsPrivateDirectoryAuthority"> = {},
): Promise<boolean> {
  const assertParent = async (): Promise<void> =>
    await assertPrivateDirectoryAuthority(generation.parent, options);
  try {
    const isolated = await isolateDirectoryGenerationForRemoval(
      generation.path,
      async (generationPath) => {
        await assertParent();
        const current = await capturePhysicalDirectoryIdentity(generationPath);
        return samePhysicalDirectoryIdentity(current, generation.identity);
      },
      generation.path,
      { assertParentAuthority: assertParent },
    );
    if (isolated.status === "missing") return true;
    if (isolated.status === "changed") return false;
    await removeIsolatedDirectoryGeneration(isolated.rootPath, {
      assertParentAuthority: assertParent,
    });
    return true;
  } catch {
    return false;
  }
}
