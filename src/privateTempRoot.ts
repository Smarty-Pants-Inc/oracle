import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capturePhysicalDirectoryIdentity,
  parsePhysicalDirectoryIdentity,
  physicalDirectoryIdentityFromStats,
  samePhysicalDirectoryIdentity,
  type PhysicalDirectoryIdentity,
} from "./browser/filesystemLockDirectoryIdentity.js";
import {
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
} from "./browser/filesystemLockDirectoryRemoval.js";
import { getOracleHomeDir } from "./oracleHome.js";
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
  /** Explicit private state parent used by focused callers and tests. */
  readonly tempDirectory?: string;
  readonly oracleStateDirectory?: string;
  readonly runtimeDirectory?: string | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly isWsl?: boolean;
  readonly randomId?: () => string;
  readonly windowsPrivateDirectoryAuthority?: WindowsPrivateDirectoryAuthority;
}

function validatePrefix(prefix: string): void {
  if (!prefix || path.basename(prefix) !== prefix || prefix === "." || prefix === "..") {
    throw new Error("Private temporary generation prefix must be a non-empty basename");
  }
}

function isWslRuntime(options: PrivateTempRootOptions, platform: NodeJS.Platform): boolean {
  if (options.isWsl !== undefined) return options.isWsl;
  if (platform !== "linux") return false;
  const environment = options.environment ?? process.env;
  return Boolean(environment.WSL_DISTRO_NAME) || os.release().toLowerCase().includes("microsoft");
}

function windowsBackedWslPath(candidate: string | undefined): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  if (/^\/mnt\/[a-z](?:\/|$)/iu.test(trimmed)) return path.resolve(trimmed);
  const native = trimmed.match(/^([a-z]):[\\/](.*)$/iu);
  if (!native?.[1]) return null;
  return path.posix.join(
    "/mnt",
    native[1].toLowerCase(),
    ...(native[2] ?? "").split(/[\\/]+/u).filter(Boolean),
  );
}

function resolveWslOracleStateDirectory(options: PrivateTempRootOptions): string {
  const configuredState = options.oracleStateDirectory ?? getOracleHomeDir();
  const configured = windowsBackedWslPath(configuredState);
  if (configured) return configured;

  const environment = options.environment ?? process.env;
  const localAppData = windowsBackedWslPath(environment.LOCALAPPDATA);
  if (localAppData) return path.join(localAppData, "Oracle");
  const userProfile = windowsBackedWslPath(environment.USERPROFILE);
  if (userProfile) return path.join(userProfile, "AppData", "Local", "Oracle");
  throw new Error(
    "WSL private runtime authority requires a current-user Windows-backed ORACLE_HOME_DIR, LOCALAPPDATA, or USERPROFILE; refusing shared Windows temp storage.",
  );
}

function oracleStateDirectory(options: PrivateTempRootOptions, platform: NodeJS.Platform): string {
  if (options.tempDirectory) return path.resolve(options.tempDirectory);
  if (isWslRuntime(options, platform)) return resolveWslOracleStateDirectory(options);
  return path.resolve(options.oracleStateDirectory ?? getOracleHomeDir());
}

function configuredPosixRuntimeDirectory(options: PrivateTempRootOptions): string | null {
  const configured =
    options.runtimeDirectory === undefined
      ? (options.environment ?? process.env).XDG_RUNTIME_DIR
      : options.runtimeDirectory;
  if (!configured || !path.isAbsolute(configured)) return null;
  return path.resolve(configured);
}

export function privateRuntimeRootPathCandidates(
  options: PrivateTempRootOptions = {},
): readonly string[] {
  const platform = options.platform ?? process.platform;
  if (options.tempDirectory) {
    return [path.join(path.resolve(options.tempDirectory), PRIVATE_TEMP_ROOT_NAME)];
  }
  if (platform === "win32" || isWslRuntime(options, platform)) {
    try {
      return [path.join(oracleStateDirectory(options, platform), PRIVATE_TEMP_ROOT_NAME)];
    } catch {
      return [];
    }
  }
  const runtimeDirectory = configuredPosixRuntimeDirectory(options);
  const stateRoot = path.join(oracleStateDirectory(options, platform), PRIVATE_TEMP_ROOT_NAME);
  return runtimeDirectory
    ? [path.join(runtimeDirectory, PRIVATE_TEMP_ROOT_NAME), stateRoot]
    : [stateRoot];
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

async function captureValidatedPosixRuntimeDirectory(
  directoryPath: string,
  platform: NodeJS.Platform,
): Promise<PrivateDirectoryAuthority> {
  const identity = await capturePhysicalDirectoryIdentity(directoryPath);
  const authority = Object.freeze({ path: await realpath(directoryPath), identity, platform });
  await assertPosixPrivateDirectory(authority);
  return authority;
}

async function establishPosixStateDirectory(
  directoryPath: string,
  platform: NodeJS.Platform,
): Promise<PrivateDirectoryAuthority> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const identity = await protectPosixPrivateDirectory(directoryPath);
  const authority = Object.freeze({ path: await realpath(directoryPath), identity, platform });
  await assertPosixPrivateDirectory(authority);
  return authority;
}

async function establishPosixPrivateRoot(
  parent: PrivateDirectoryAuthority,
): Promise<PrivateDirectoryAuthority> {
  await assertPrivateDirectoryAuthority(parent);
  const rootPath = path.join(parent.path, PRIVATE_TEMP_ROOT_NAME);
  try {
    await mkdir(rootPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const identity = await protectPosixPrivateDirectory(rootPath);
  await assertPrivateDirectoryAuthority(parent);
  const authority = Object.freeze({
    path: await realpath(rootPath),
    identity,
    platform: parent.platform,
  });
  await assertPrivateDirectoryAuthority(authority);
  return authority;
}

async function establishWindowsPrivateRoot(
  options: PrivateTempRootOptions,
): Promise<PrivateDirectoryAuthority> {
  const stateDirectory = oracleStateDirectory(options, "win32");
  const windowsAuthority =
    options.windowsPrivateDirectoryAuthority ?? establishWindowsPrivateDirectory;
  if (!options.tempDirectory) {
    await mkdir(stateDirectory, { recursive: true });
  }
  const stateEntry = await lstat(stateDirectory);
  if (!stateEntry.isDirectory() || stateEntry.isSymbolicLink()) {
    throw new Error(`Oracle state path is not a physical directory: ${stateDirectory}`);
  }
  const rootPath = path.join(await realpath(stateDirectory), PRIVATE_TEMP_ROOT_NAME);
  await windowsAuthority(rootPath);
  const authority = Object.freeze({
    path: rootPath,
    identity: await capturePhysicalDirectoryIdentity(rootPath),
    platform: "win32" as const,
  });
  await assertPrivateDirectoryAuthority(authority, options);
  return authority;
}

export async function establishPrivateRuntimeAuthority(
  options: PrivateTempRootOptions = {},
): Promise<PrivateDirectoryAuthority> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return await establishWindowsPrivateRoot(options);

  if (!options.tempDirectory && !isWslRuntime(options, platform)) {
    const runtimeDirectory = configuredPosixRuntimeDirectory(options);
    if (runtimeDirectory) {
      try {
        return await establishPosixPrivateRoot(
          await captureValidatedPosixRuntimeDirectory(runtimeDirectory, platform),
        );
      } catch {
        // Invalid or unavailable XDG runtime authority falls back to the private Oracle state root.
      }
    }
  }
  const state = await establishPosixStateDirectory(
    oracleStateDirectory(options, platform),
    platform,
  );
  return await establishPosixPrivateRoot(state);
}

export function parsePrivateDirectoryAuthority(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): PrivateDirectoryAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const identity = parsePhysicalDirectoryIdentity(candidate.identity);
  if (
    Object.keys(candidate).sort().join(",") !== "identity,path,platform" ||
    candidate.platform !== platform ||
    typeof candidate.path !== "string" ||
    !path.isAbsolute(candidate.path) ||
    path.resolve(candidate.path) !== candidate.path ||
    !identity
  ) {
    return null;
  }
  return Object.freeze({ path: candidate.path, identity, platform });
}

export function parsePrivateTempGeneration(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): PrivateTempGeneration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const identity = parsePhysicalDirectoryIdentity(candidate.identity);
  const parent = parsePrivateDirectoryAuthority(candidate.parent, platform);
  if (
    Object.keys(candidate).sort().join(",") !== "identity,parent,path,platform" ||
    candidate.platform !== platform ||
    typeof candidate.path !== "string" ||
    !path.isAbsolute(candidate.path) ||
    path.resolve(candidate.path) !== candidate.path ||
    path.dirname(candidate.path) !== parent?.path ||
    !identity ||
    !parent
  ) {
    return null;
  }
  return Object.freeze({ parent, path: candidate.path, identity, platform });
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
  if (parent.platform === "win32" || options.randomId) {
    const generationName = `${prefix}${(options.randomId ?? randomUUID)()}`;
    validatePrefix(generationName);
    generationPath = path.join(parent.path, generationName);
    if (parent.platform === "win32") {
      await (options.windowsPrivateDirectoryAuthority ?? establishWindowsPrivateDirectory)(
        generationPath,
      );
      identity = await capturePhysicalDirectoryIdentity(generationPath);
    } else {
      await mkdir(generationPath, { mode: 0o700 });
      identity = await protectPosixPrivateDirectory(generationPath);
    }
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
  await assertPrivateTempGeneration(generation, options);
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
  const root = await establishPrivateRuntimeAuthority(options);
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
