import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { captureProfileDirectoryIdentity } from "../../src/browser/profileState.js";
import * as recovery from "../../src/browser/projectSourcesRecovery.js";
import { resolveWindowsPowerShellExecutable } from "../../src/windowsSystemExecutable.js";
import { createTemporaryProfileChildAuthority } from "../../src/privateTempRoot.js";

const execFileAsync = promisify(execFile);
const windowsTest = test.skipIf(process.platform !== "win32");

interface StorageFixture {
  readonly oracleHome: string;
  readonly storage: recovery.ProjectSourcesCleanupStorage;
  readonly intent: recovery.ProjectSourcesProfileCreateIntent;
}

async function createStorageFixture(): Promise<StorageFixture> {
  const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-windows-root-"));
  const storage = await recovery.establishProjectSourcesCleanupStorage(oracleHome);
  const parent = await captureProfileDirectoryIdentity(storage.runtimeRoot.path);
  const intent = recovery.createProjectSourcesProfileCreateIntent(storage, parent, randomUUID());
  await recovery.persistProjectSourcesCleanupRuntime({}, storage, { profileCreate: intent });
  return { oracleHome, storage, intent };
}

async function removeFixture(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((candidate) => rm(candidate, { recursive: true, force: true })));
}

async function addEveryoneReadAcl(directoryPath: string): Promise<void> {
  const encodedPath = Buffer.from(directoryPath, "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$DirectoryPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPath}'))
$Directory = [System.IO.DirectoryInfo]::new($DirectoryPath)
$Acl = $Directory.GetAccessControl()
$Everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$Inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$Rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $Everyone,
  [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
  $Inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$Acl.AddAccessRule($Rule)
$Directory.SetAccessControl($Acl)
`;
  await execFileAsync(
    resolveWindowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", windowsHide: true },
  );
}

windowsTest(
  "keeps exact Project Sources storage valid across module reload and ordinary child writes",
  async () => {
    const fixture = await createStorageFixture();
    try {
      await mkdir(path.join(fixture.oracleHome, "ordinary-child"));
      await writeFile(
        path.join(fixture.storage.runtimeRoot.path, "ordinary-child.txt"),
        "ordinary",
      );
      const temporaryProfileAuthority = await createTemporaryProfileChildAuthority(
        fixture.storage.runtimeRoot,
        "oracle-browser-",
        { randomId: () => fixture.intent.generationId },
      );
      const establishedIntent = { ...fixture.intent, temporaryProfileAuthority };
      const proof = await recovery.createProjectSourcesTemporaryCleanupProof(
        establishedIntent,
        fixture.storage,
      );
      await recovery.persistProjectSourcesCleanupRuntime({}, fixture.storage, {
        profileCreate: { ...establishedIntent, proof },
      });
      vi.resetModules();
      // Intentional reload proves persisted storage authority does not depend on module-local state.
      const reloadedRecovery = await import("../../src/browser/projectSourcesRecovery.js");
      await expect(
        reloadedRecovery.assertProjectSourcesCleanupStorage(fixture.storage),
      ).resolves.toBeUndefined();
      await expect(
        reloadedRecovery.readProjectSourcesCleanupJournal(fixture.storage),
      ).resolves.toMatchObject({
        profileCreate: {
          generationId: fixture.intent.generationId,
          temporaryProfileAuthority: {
            generation: { path: temporaryProfileAuthority.generation.path },
            profileDirectory: {
              canonicalPath: temporaryProfileAuthority.profileDirectory.canonicalPath,
            },
          },
        },
      });
      await expect(
        reloadedRecovery.retryPendingProjectSourcesCleanup(() => undefined, fixture.storage),
      ).resolves.toBeUndefined();
      await expect(
        readFile(temporaryProfileAuthority.generation.path, "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(fixture.storage.journalPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await removeFixture(fixture.oracleHome);
    }
  },
  20_000,
);

windowsTest(
  "rejects an Oracle-home generation substitution before retiring Project Sources authority",
  async () => {
    const fixture = await createStorageFixture();
    const displaced = `${fixture.oracleHome}-displaced`;
    const originalJournal = await readFile(fixture.storage.journalPath, "utf8");
    try {
      await rename(fixture.oracleHome, displaced);
      await mkdir(fixture.oracleHome);
      const replacementSentinel = path.join(fixture.oracleHome, "replacement-owner.txt");
      await writeFile(replacementSentinel, "preserve replacement");

      await expect(
        recovery.persistProjectSourcesCleanupRuntime({}, fixture.storage),
      ).rejects.toThrow(/Oracle-home physical authority changed/i);
      await expect(readFile(replacementSentinel, "utf8")).resolves.toBe("preserve replacement");
      await expect(
        readFile(path.join(displaced, path.basename(fixture.storage.journalPath)), "utf8"),
      ).resolves.toBe(originalJournal);
    } finally {
      await removeFixture(fixture.oracleHome, displaced);
    }
  },
  20_000,
);

windowsTest(
  "rejects a private runtime reparse substitution before retiring Project Sources authority",
  async () => {
    const fixture = await createStorageFixture();
    const displaced = `${fixture.storage.runtimeRoot.path}-displaced`;
    const originalJournal = await readFile(fixture.storage.journalPath, "utf8");
    try {
      await rename(fixture.storage.runtimeRoot.path, displaced);
      await symlink(displaced, fixture.storage.runtimeRoot.path, "junction");
      const replacementSentinel = path.join(displaced, "replacement-owner.txt");
      await writeFile(replacementSentinel, "preserve replacement");

      await expect(
        recovery.persistProjectSourcesCleanupRuntime({}, fixture.storage),
      ).rejects.toThrow(/physical directory|authority changed/i);
      await expect(readFile(replacementSentinel, "utf8")).resolves.toBe("preserve replacement");
      await expect(readFile(fixture.storage.journalPath, "utf8")).resolves.toBe(originalJournal);
    } finally {
      await removeFixture(fixture.oracleHome);
    }
  },
  20_000,
);

windowsTest(
  "rejects private runtime ACL tampering before retiring Project Sources authority",
  async () => {
    const fixture = await createStorageFixture();
    const originalJournal = await readFile(fixture.storage.journalPath, "utf8");
    try {
      await addEveryoneReadAcl(fixture.storage.runtimeRoot.path);

      await expect(
        recovery.persistProjectSourcesCleanupRuntime({}, fixture.storage),
      ).rejects.toThrow(/Windows private directory protection failed/i);
      await expect(readFile(fixture.storage.journalPath, "utf8")).resolves.toBe(originalJournal);
    } finally {
      await removeFixture(fixture.oracleHome);
    }
  },
  20_000,
);
