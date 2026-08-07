import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import type { UserConfig } from "../config.js";
import {
  capturePhysicalDirectoryIdentity,
  samePhysicalDirectoryIdentity,
  type PhysicalDirectoryIdentity,
} from "../browser/filesystemLockDirectoryIdentity.js";
import { readErrorCode, syncDirectoryIfPresent } from "../fsDurability.js";
import {
  physicalFileGenerationFromStats,
  physicalFileSnapshotFromStats,
  samePhysicalFileGeneration,
  samePhysicalFileSnapshot,
  type PhysicalFileSnapshot,
} from "../physicalFileIdentity.js";
import {
  applyWindowsPrivateFileAcl,
  protectWindowsPrivateFile,
  verifyWindowsPrivateFile,
  type WindowsPrivateFileAuthority,
  type WindowsPrivateFileProtectionAuthority,
  type WindowsPrivateFileVerificationAuthority,
} from "../windowsPrivateFileAcl.js";

interface ConfigFileSnapshot {
  readonly contents: Buffer | null;
  readonly directoryIdentity: PhysicalDirectoryIdentity | null;
  readonly fileIdentity: PhysicalFileSnapshot | null;
}

export interface UserConfigFileAuthorities {
  readonly platform?: NodeJS.Platform;
  readonly windowsPrivateFileAuthority?: WindowsPrivateFileAuthority;
  readonly windowsPrivateFileProtectionAuthority?: WindowsPrivateFileProtectionAuthority;
  readonly windowsPrivateFileVerificationAuthority?: WindowsPrivateFileVerificationAuthority;
}

interface ResolvedUserConfigFileAuthorities {
  readonly platform: NodeJS.Platform;
  readonly create: WindowsPrivateFileAuthority;
  readonly protect: WindowsPrivateFileProtectionAuthority;
  readonly verify: WindowsPrivateFileVerificationAuthority;
}

function resolveUserConfigFileAuthorities(
  authorities: UserConfigFileAuthorities,
): ResolvedUserConfigFileAuthorities {
  return {
    platform: authorities.platform ?? process.platform,
    create: authorities.windowsPrivateFileAuthority ?? applyWindowsPrivateFileAcl,
    protect: authorities.windowsPrivateFileProtectionAuthority ?? protectWindowsPrivateFile,
    verify: authorities.windowsPrivateFileVerificationAuthority ?? verifyWindowsPrivateFile,
  };
}

function resolvedConfigPath(configPath: string): string {
  if (!configPath || configPath.includes("\0")) throw new Error("User config path is invalid");
  return path.resolve(configPath);
}

function assertPhysicalConfigFile(entry: BigIntStats, filePath: string): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) {
    throw new Error(`User config is not a singly linked physical file: ${filePath}`);
  }
}

function assertControllerOwnedPosixFile(entry: BigIntStats, filePath: string): void {
  const currentUserId = process.geteuid?.() ?? process.getuid?.();
  if (currentUserId !== undefined && entry.uid !== BigInt(currentUserId)) {
    throw new Error(`User config is not owned by the current user: ${filePath}`);
  }
}

async function readExactOpenFile(handle: FileHandle, size: bigint): Promise<Buffer> {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("User config is too large to read");
  const contents = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < contents.byteLength) {
    const { bytesRead } = await handle.read(contents, offset, contents.byteLength - offset, offset);
    if (bytesRead === 0) throw new Error("User config changed while it was being read");
    offset += bytesRead;
  }
  return contents;
}

async function captureSecureConfigSnapshot(
  filePath: string,
  authorities: ResolvedUserConfigFileAuthorities,
): Promise<ConfigFileSnapshot> {
  const directory = path.dirname(filePath);
  let initial: BigIntStats;
  try {
    initial = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    let directoryIdentity: PhysicalDirectoryIdentity | null;
    try {
      directoryIdentity = await capturePhysicalDirectoryIdentity(directory);
    } catch (directoryError) {
      if (readErrorCode(directoryError) === "ENOENT") {
        return { contents: null, directoryIdentity: null, fileIdentity: null };
      }
      throw directoryError;
    }
    const confirmedDirectory = await capturePhysicalDirectoryIdentity(directory);
    if (!samePhysicalDirectoryIdentity(directoryIdentity, confirmedDirectory)) {
      throw new Error("User config parent changed while absence was verified");
    }
    return { contents: null, directoryIdentity: confirmedDirectory, fileIdentity: null };
  }

  assertPhysicalConfigFile(initial, filePath);
  const initialGeneration = physicalFileGenerationFromStats(initial);
  if (authorities.platform === "win32") {
    await authorities.protect(filePath);
  } else {
    assertControllerOwnedPosixFile(initial, filePath);
  }

  const directoryIdentity = await capturePhysicalDirectoryIdentity(directory);
  const flags =
    authorities.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await fs.open(filePath, flags);
  try {
    let opened = await handle.stat({ bigint: true });
    assertPhysicalConfigFile(opened, filePath);
    if (!samePhysicalFileGeneration(physicalFileGenerationFromStats(opened), initialGeneration)) {
      throw new Error("User config generation changed before private read");
    }
    if (authorities.platform === "win32") {
      await authorities.verify(filePath);
    } else {
      assertControllerOwnedPosixFile(opened, filePath);
      await handle.chmod(0o600);
    }
    opened = await handle.stat({ bigint: true });
    const named = await fs.lstat(filePath, { bigint: true });
    assertPhysicalConfigFile(opened, filePath);
    assertPhysicalConfigFile(named, filePath);
    if (authorities.platform !== "win32") {
      assertControllerOwnedPosixFile(opened, filePath);
      if ((opened.mode & 0o777n) !== 0o600n || (named.mode & 0o777n) !== 0o600n) {
        throw new Error(`User config permissions must be 0600: ${filePath}`);
      }
    }
    const privateIdentity = physicalFileSnapshotFromStats(opened);
    if (!samePhysicalFileSnapshot(physicalFileSnapshotFromStats(named), privateIdentity)) {
      throw new Error("User config path changed before private read");
    }
    const contents = await readExactOpenFile(handle, opened.size);
    const afterRead = await handle.stat({ bigint: true });
    const namedAfterRead = await fs.lstat(filePath, { bigint: true });
    if (
      afterRead.size !== opened.size ||
      namedAfterRead.size !== opened.size ||
      !samePhysicalFileSnapshot(physicalFileSnapshotFromStats(afterRead), privateIdentity) ||
      !samePhysicalFileSnapshot(physicalFileSnapshotFromStats(namedAfterRead), privateIdentity)
    ) {
      throw new Error("User config changed while it was being read");
    }
    const directoryAfterRead = await capturePhysicalDirectoryIdentity(directory);
    if (!samePhysicalDirectoryIdentity(directoryIdentity, directoryAfterRead)) {
      throw new Error("User config parent changed while it was being read");
    }
    return { contents, directoryIdentity: directoryAfterRead, fileIdentity: privateIdentity };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function fileGenerationAt(
  filePath: string,
  allowMultipleLinks = false,
): Promise<PhysicalFileSnapshot | null> {
  try {
    const entry = await fs.lstat(filePath, { bigint: true });
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink < 1n ||
      (!allowMultipleLinks && entry.nlink !== 1n)
    ) {
      throw new Error(`User config is not a physical file: ${filePath}`);
    }
    return physicalFileSnapshotFromStats(entry);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function removeExactConfigFile(
  filePath: string,
  expected: PhysicalFileSnapshot,
): Promise<boolean> {
  const current = await fileGenerationAt(filePath, true);
  if (current === null) return true;
  if (!samePhysicalFileGeneration(current, expected)) return false;
  await fs.unlink(filePath);
  return true;
}

async function restorePredecessor(
  filePath: string,
  quarantinePath: string,
  predecessor: PhysicalFileSnapshot,
  predecessorContents: Buffer,
  authorities: ResolvedUserConfigFileAuthorities,
): Promise<void> {
  const quarantinedSnapshot = await captureSecureConfigSnapshot(quarantinePath, authorities);
  if (
    quarantinedSnapshot.contents === null ||
    quarantinedSnapshot.fileIdentity === null ||
    !samePhysicalFileGeneration(quarantinedSnapshot.fileIdentity, predecessor) ||
    !quarantinedSnapshot.contents.equals(predecessorContents)
  ) {
    throw new Error(`User config predecessor changed; preserved at ${quarantinePath}`);
  }
  const current = await fileGenerationAt(filePath, true);
  if (current !== null) {
    if (!samePhysicalFileGeneration(current, predecessor)) {
      throw new Error(
        `User config predecessor preserved at ${quarantinePath}; destination is occupied`,
      );
    }
  } else {
    await fs.link(quarantinePath, filePath);
  }
  const restored = await fileGenerationAt(filePath, true);
  if (restored === null || !samePhysicalFileGeneration(restored, predecessor)) {
    throw new Error("User config predecessor changed during restoration");
  }
  if (authorities.platform === "win32") await authorities.verify(filePath);
  const quarantined = await fileGenerationAt(quarantinePath, true);
  if (quarantined !== null && samePhysicalFileGeneration(quarantined, predecessor)) {
    await fs.unlink(quarantinePath);
  }
  await syncDirectoryIfPresent(path.dirname(filePath));
  const finalSnapshot = await captureSecureConfigSnapshot(filePath, authorities);
  if (
    finalSnapshot.contents === null ||
    finalSnapshot.fileIdentity === null ||
    !samePhysicalFileGeneration(finalSnapshot.fileIdentity, predecessor) ||
    !finalSnapshot.contents.equals(predecessorContents)
  ) {
    throw new Error("User config predecessor changed after restoration");
  }
}

export async function readUserConfigFile(
  configPath: string,
  authorityOptions: UserConfigFileAuthorities = {},
): Promise<{ config: UserConfig; loaded: boolean }> {
  const filePath = resolvedConfigPath(configPath);
  const authorities = resolveUserConfigFileAuthorities(authorityOptions);
  try {
    const snapshot = await captureSecureConfigSnapshot(filePath, authorities);
    if (snapshot.contents === null) return { config: {}, loaded: false };
    const parsed = JSON5.parse(snapshot.contents.toString("utf8")) as UserConfig;
    return { config: parsed ?? {}, loaded: true };
  } catch (error) {
    throw new Error(
      `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function writeUserConfigFile(
  configPath: string,
  config: UserConfig,
  authorityOptions: UserConfigFileAuthorities = {},
): Promise<void> {
  const filePath = resolvedConfigPath(configPath);
  const authorities = resolveUserConfigFileAuthorities(authorityOptions);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshot = await captureSecureConfigSnapshot(filePath, authorities);
  const directoryIdentity = await capturePhysicalDirectoryIdentity(directory);
  if (
    snapshot.directoryIdentity !== null &&
    !samePhysicalDirectoryIdentity(snapshot.directoryIdentity, directoryIdentity)
  ) {
    throw new Error("User config parent changed before publication");
  }

  const contents = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
  const temporaryPath = path.join(
    directory,
    `.oracle-config-${randomBytes(16).toString("hex")}.tmp`,
  );
  const quarantinePath = path.join(
    directory,
    `.oracle-config-rollback-${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;
  let temporaryIdentity: PhysicalFileSnapshot | undefined;
  let temporaryPresent = false;
  let predecessorQuarantined = false;
  let finalPublished = false;
  try {
    if (authorities.platform === "win32") {
      await authorities.create({
        filePath: temporaryPath,
        repair: false,
        createNew: true,
      });
      handle = await fs.open(temporaryPath, "r+");
    } else {
      handle = await fs.open(
        temporaryPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    }
    temporaryPresent = true;
    let temporaryStat = await handle.stat({ bigint: true });
    assertPhysicalConfigFile(temporaryStat, temporaryPath);
    if (temporaryStat.size !== 0n) throw new Error("User config temporary file is not empty");
    temporaryIdentity = physicalFileSnapshotFromStats(temporaryStat);
    const temporaryNamed = await fs.lstat(temporaryPath, { bigint: true });
    assertPhysicalConfigFile(temporaryNamed, temporaryPath);
    if (
      !samePhysicalFileSnapshot(physicalFileSnapshotFromStats(temporaryNamed), temporaryIdentity)
    ) {
      throw new Error("User config temporary file changed before write");
    }
    if (authorities.platform === "win32") {
      await authorities.verify(temporaryPath);
    } else {
      assertControllerOwnedPosixFile(temporaryStat, temporaryPath);
      await handle.chmod(0o600);
    }
    await handle.writeFile(contents);
    await handle.sync();
    temporaryStat = await handle.stat({ bigint: true });
    if (
      temporaryStat.size !== BigInt(contents.byteLength) ||
      !samePhysicalFileGeneration(physicalFileGenerationFromStats(temporaryStat), temporaryIdentity)
    ) {
      throw new Error("User config temporary file changed during write");
    }
    const confirmedContents = await readExactOpenFile(handle, temporaryStat.size);
    if (!confirmedContents.equals(contents)) {
      throw new Error("User config temporary file failed exact verification");
    }
    await handle.close();
    handle = undefined;

    const currentDirectory = await capturePhysicalDirectoryIdentity(directory);
    if (!samePhysicalDirectoryIdentity(currentDirectory, directoryIdentity)) {
      throw new Error("User config parent changed before publication");
    }
    if (snapshot.fileIdentity !== null) {
      await fs.rename(filePath, quarantinePath);
      predecessorQuarantined = true;
      const quarantined = await fileGenerationAt(quarantinePath);
      if (quarantined === null || !samePhysicalFileGeneration(quarantined, snapshot.fileIdentity)) {
        throw new Error("User config predecessor changed before publication");
      }
      if (authorities.platform === "win32") await authorities.verify(quarantinePath);
    }
    await fs.link(temporaryPath, filePath);
    finalPublished = true;
    await fs.unlink(temporaryPath);
    temporaryPresent = false;
    await syncDirectoryIfPresent(directory);
    const published = await fileGenerationAt(filePath);
    if (published === null || !samePhysicalFileGeneration(published, temporaryIdentity)) {
      throw new Error("User config changed during atomic publication");
    }
    if (authorities.platform === "win32") await authorities.verify(filePath);
    const verified = await captureSecureConfigSnapshot(filePath, authorities);
    if (
      verified.contents === null ||
      verified.directoryIdentity === null ||
      verified.fileIdentity === null ||
      !samePhysicalDirectoryIdentity(verified.directoryIdentity, directoryIdentity) ||
      !samePhysicalFileGeneration(verified.fileIdentity, temporaryIdentity) ||
      !verified.contents.equals(contents)
    ) {
      throw new Error("User config failed final exact verification");
    }
    if (predecessorQuarantined && snapshot.fileIdentity !== null) {
      if (!(await removeExactConfigFile(quarantinePath, snapshot.fileIdentity))) {
        throw new Error("User config predecessor changed before retirement");
      }
      predecessorQuarantined = false;
      await syncDirectoryIfPresent(directory);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    await handle?.close().catch((closeError) => rollbackErrors.push(closeError));
    if (finalPublished && temporaryIdentity !== undefined) {
      try {
        if (!(await removeExactConfigFile(filePath, temporaryIdentity))) {
          throw new Error("Unexpected user config replacement prevented publication rollback");
        }
        await syncDirectoryIfPresent(directory);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (predecessorQuarantined && snapshot.fileIdentity !== null) {
      try {
        if (snapshot.contents === null) {
          throw new Error("User config predecessor contents are unavailable for rollback");
        }
        await restorePredecessor(
          filePath,
          quarantinePath,
          snapshot.fileIdentity,
          snapshot.contents,
          authorities,
        );
        predecessorQuarantined = false;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (temporaryPresent && temporaryIdentity !== undefined) {
      try {
        if (!(await removeExactConfigFile(temporaryPath, temporaryIdentity))) {
          throw new Error("Unexpected user config temporary replacement prevented cleanup");
        }
        await syncDirectoryIfPresent(directory);
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "User config publication failed and could not be fully rolled back",
      );
    }
    throw error;
  }
}
