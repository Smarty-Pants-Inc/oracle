import { lstat, mkdir, open } from "node:fs/promises";
import type {
  WindowsPrivateDirectoriesAuthority,
  WindowsPrivateDirectoryAuthority,
  WindowsPrivateFileAclRequest,
  WindowsPrivateFileAuthority,
  WindowsPrivateFileInitializationAuthority,
  WindowsPrivateFileProtectionAuthority,
  WindowsPrivateFileVerificationAuthority,
  WindowsPrivateTreeAuthority,
} from "../src/windowsPrivateFileAcl.js";

async function assertPhysicalDirectory(directoryPath: string): Promise<void> {
  const entry = await lstat(directoryPath);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Test private directory is not physical: ${directoryPath}`);
  }
}

async function assertPhysicalFile(filePath: string): Promise<void> {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Test private file is not physical: ${filePath}`);
  }
}

export const testWindowsPrivateDirectoryAuthority: WindowsPrivateDirectoryAuthority = async (
  directoryPath,
) => {
  await mkdir(directoryPath, { recursive: true });
  await assertPhysicalDirectory(directoryPath);
};

export const testWindowsPrivateDirectoriesAuthority: WindowsPrivateDirectoriesAuthority = async (
  directoryPaths,
) => {
  for (const directoryPath of directoryPaths) {
    await testWindowsPrivateDirectoryAuthority(directoryPath);
  }
};

export const testWindowsPrivateFileInitializationAuthority: WindowsPrivateFileInitializationAuthority =
  async (filePath) => {
    try {
      const handle = await open(filePath, "wx", 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertPhysicalFile(filePath);
      return false;
    }
  };

export const testWindowsPrivateFileProtectionAuthority: WindowsPrivateFileProtectionAuthority =
  assertPhysicalFile;

export const testWindowsPrivateFileVerificationAuthority: WindowsPrivateFileVerificationAuthority =
  assertPhysicalFile;

export const testWindowsPrivateFileAuthority: WindowsPrivateFileAuthority = async (
  request: WindowsPrivateFileAclRequest,
) => {
  if (request.createNew) {
    if (!(await testWindowsPrivateFileInitializationAuthority(request.filePath))) {
      throw new Error(`Test private file already exists: ${request.filePath}`);
    }
    return;
  }
  await testWindowsPrivateFileVerificationAuthority(request.filePath);
};

export const testWindowsPrivateTreeAuthority: WindowsPrivateTreeAuthority = async (scope) => {
  if (scope.initializeRoots) {
    await testWindowsPrivateDirectoriesAuthority([
      scope.integrityKeyDirectory,
      scope.storeDirectory,
      scope.authorityDirectory ?? scope.storeDirectory,
    ]);
  }
  if (scope.initializeIntegrityKey) {
    await testWindowsPrivateFileAuthority({
      filePath: scope.integrityKeyPath,
      createNew: true,
      repair: false,
    });
  }
  if (scope.initializeFilePath) {
    await testWindowsPrivateFileAuthority({
      filePath: scope.initializeFilePath,
      createNew: true,
      repair: false,
    });
  }
};
