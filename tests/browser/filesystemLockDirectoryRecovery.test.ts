import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type * as NodeFsPromisesModule from "node:fs/promises";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
} from "../../src/browser/filesystemLock.js";
import type { BrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";
import type * as FilesystemLockIoModule from "../../src/browser/filesystemLockIo.js";
import { retryPendingFilesystemLockReleases } from "../../src/browser/filesystemLockReleaseJournal.js";
import { agePath, createProcessIdentityProvider } from "./filesystemLockTestHelpers.js";

describe("crash-recoverable filesystem lock", () => {
  test("reclaims a crash-left lock directory after the incomplete-state grace period", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    try {
      await mkdir(lockPath);
      await agePath(lockPath);

      const lock = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        { incompleteLockStaleMs: 100 },
        {
          processIdentityProvider: createProcessIdentityProvider(
            10_001,
            async () => "current-start",
          ),
        },
      );
      expect(lock.owner).toMatchObject({
        pid: 10_001,
        processStartIdentity: "current-start",
      });
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reclaims a real lock after its owner process is killed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-process-"));
    const lockPath = path.join(root, "recovery.lock");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const moduleUrl = new URL("../../src/browser/filesystemLock.ts", import.meta.url).href;
      const source = `
        import { acquireCrashRecoverableFilesystemLock } from ${JSON.stringify(moduleUrl)};
        const lock = await acquireCrashRecoverableFilesystemLock(process.argv[1]);
        void lock;
        process.stdout.write("ready\\n");
        setInterval(() => undefined, 1_000);
      `;
      child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source, lockPath],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const observed = await Promise.race([
        once(child.stdout!, "data").then(([chunk]) => ({ kind: "ready", output: String(chunk) })),
        once(child, "exit").then(([code, signal]) => ({ kind: "exit", code, signal })),
      ]);
      expect(observed).toMatchObject({ kind: "ready", output: expect.stringContaining("ready") });

      const childExited = once(child, "exit");
      expect(child.kill("SIGKILL")).toBe(true);
      await childExited;
      child = undefined;

      const replacement = await acquireCrashRecoverableFilesystemLock(lockPath, {
        timeoutMs: 5_000,
        pollMs: 10,
      });
      expect(replacement.owner.pid).toBe(process.pid);
      await replacement.release();
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const childExited = once(child, "exit");
        child.kill("SIGKILL");
        await childExited.catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("reclaims an aged truncated owner only when it has no provable live owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const ownerPath = path.join(lockPath, "owner.json");
    try {
      await mkdir(lockPath);
      await writeFile(ownerPath, '{"pid":', "utf8");
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          { incompleteLockStaleMs: 60_000 },
          {
            processIdentityProvider: createProcessIdentityProvider(
              10_002,
              async () => "current-start",
            ),
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);

      await agePath(ownerPath, 120_000);
      await agePath(lockPath, 120_000);
      const lock = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        { incompleteLockStaleMs: 60_000 },
        {
          processIdentityProvider: createProcessIdentityProvider(
            10_002,
            async () => "current-start",
          ),
        },
      );
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for an aged malformed owner whose pid is provably live", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const ownerPath = path.join(lockPath, "owner.json");
    try {
      await mkdir(lockPath);
      await writeFile(ownerPath, JSON.stringify({ pid: 41_041 }), "utf8");
      await agePath(ownerPath);
      await agePath(lockPath);

      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          { incompleteLockStaleMs: 100 },
          {
            processIdentityProvider: createProcessIdentityProvider(
              10_003,
              async (pid) => (pid === 41_041 ? null : "current-process-start"),
              (pid) => (pid === 41_041 ? "alive" : "dead"),
            ),
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test.runIf(process.platform === "linux" || process.platform === "darwin")(
    "bound helper deletes only the attested root generation after pathname substitution",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-bound-delete-"));
      const candidatePath = path.join(root, "candidate");
      const movedRootPath = path.join(root, "moved-isolation-root");
      await mkdir(path.join(candidatePath, "nested"), { recursive: true });
      await writeFile(path.join(candidatePath, "nested", "owned-marker"), "delete");
      try {
        const isolation = await isolateDirectoryGenerationForRemoval(
          candidatePath,
          async (generationPath) => (await stat(generationPath)).isDirectory(),
        );
        expect(isolation.status).toBe("isolated");
        if (isolation.status !== "isolated") throw new Error("Expected isolated generation");

        await expect(
          removeIsolatedDirectoryGeneration(isolation.rootPath, {
            afterChildAttestation: async (isolatedRootPath) => {
              await rename(isolatedRootPath, movedRootPath);
              await mkdir(isolatedRootPath);
              await writeFile(path.join(isolatedRootPath, "replacement-marker"), "preserve");
            },
          }),
        ).rejects.toThrow(/identity changed/i);

        await expect(stat(path.join(movedRootPath, "generation"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          readFile(path.join(isolation.rootPath, "replacement-marker"), "utf8"),
        ).resolves.toBe("preserve");
        await expect(
          retryPendingFilesystemLockReleases(path.join(root, "recovery.lock")),
        ).resolves.toBeUndefined();
        await expect(
          readFile(path.join(isolation.rootPath, "replacement-marker"), "utf8"),
        ).resolves.toBe("preserve");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.runIf(
    process.platform === "linux" || process.platform === "darwin" || process.platform === "win32",
  )("deletes an ordinary isolated generation with the bound helper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-bound-delete-"));
    const candidatePath = path.join(root, "candidate");
    await mkdir(path.join(candidatePath, "nested"), { recursive: true });
    await writeFile(path.join(candidatePath, "nested", "owned-marker"), "delete");
    try {
      const isolation = await isolateDirectoryGenerationForRemoval(
        candidatePath,
        async (generationPath) => (await stat(generationPath)).isDirectory(),
      );
      expect(isolation.status).toBe("isolated");
      if (isolation.status !== "isolated") throw new Error("Expected isolated generation");

      await expect(removeIsolatedDirectoryGeneration(isolation.rootPath)).resolves.toBeUndefined();
      await expect(stat(isolation.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(candidatePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.runIf(
    process.platform === "linux" || process.platform === "darwin" || process.platform === "win32",
  )("waits for journaled generation preparation during tab-lease reacquisition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-preparation-race-"));
    const lockPath = path.join(root, "oracle-tab-leases.lock");
    const generationRenameStarted = Promise.withResolvers<void>();
    const allowGenerationRename = Promise.withResolvers<void>();
    const preparationWaitObserved = Promise.withResolvers<string>();
    const prematureRootRemoval = Promise.withResolvers<string>();
    const actualFs = await vi.importActual<typeof NodeFsPromisesModule>("node:fs/promises");
    const actualIo = await vi.importActual<typeof FilesystemLockIoModule>(
      "../../src/browser/filesystemLockIo.js",
    );
    let firstRelease: Promise<void> | undefined;
    let secondAcquisition: Promise<BrowserTabLease> | undefined;
    let secondLease: BrowserTabLease | undefined;
    let generationRenameCount = 0;
    let pausedRootPath: string | undefined;

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      rmdir: async (...args: unknown[]) => {
        const rootPath = path.resolve(String(args[0]));
        if (rootPath === pausedRootPath) prematureRootRemoval.resolve(rootPath);
        return Reflect.apply(actualFs.rmdir, actualFs, args);
      },
    }));
    vi.doMock("../../src/browser/filesystemLockIo.js", () => ({
      ...actualIo,
      renameLockPath: async (sourcePath: string, destinationPath: string) => {
        if (
          path.basename(destinationPath) === "generation" &&
          path.basename(sourcePath).includes(".released-")
        ) {
          generationRenameCount += 1;
          if (generationRenameCount === 2) {
            generationRenameStarted.resolve();
            await allowGenerationRename.promise;
          }
        }
        await actualIo.renameLockPath(sourcePath, destinationPath);
      },
    }));
    // Reloading is intentional: the mocked ESM binding must be captured by this isolated graph.
    const { acquireBrowserTabLease: acquireIsolatedBrowserTabLease } =
      await import("../../src/browser/tabLeaseRegistry.js");
    const { __test__: directoryRemovalTest } =
      await import("../../src/browser/filesystemLockDirectoryRemoval.js");

    try {
      const firstLease = await acquireIsolatedBrowserTabLease(
        root,
        {
          maxConcurrentTabs: 1,
          timeoutMs: 1_000,
          sessionId: "first-tab-lease-owner",
          generationId: "first-tab-lease-generation",
          leaseId: "first-tab-lease",
        },
        { readProcessStartIdentity: async () => "first-tab-lease-start" },
      );
      firstRelease = firstLease.release();
      await generationRenameStarted.promise;

      const journalName = (await readdir(root)).find((entry) =>
        entry.endsWith(".cleanup-journal.json"),
      );
      expect(journalName).toBeDefined();
      const journalPath = path.join(root, journalName!);
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { rootPath: string };
      expect(await readdir(journal.rootPath)).toEqual([]);
      await expect(stat(path.join(journal.rootPath, "generation"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      pausedRootPath = journal.rootPath;
      expect((await readdir(root)).some((entry) => entry.includes(".released-"))).toBe(true);

      directoryRemovalTest.setBeforePreparationWait((rootPath) => {
        preparationWaitObserved.resolve(rootPath);
      });
      secondAcquisition = acquireIsolatedBrowserTabLease(
        root,
        {
          maxConcurrentTabs: 1,
          timeoutMs: 1_000,
          pollMs: 50,
          sessionId: "second-tab-lease-owner",
          generationId: "second-tab-lease-generation",
          leaseId: "second-tab-lease",
        },
        { readProcessStartIdentity: async () => "second-tab-lease-start" },
      ).then((lease) => {
        secondLease = lease;
        return lease;
      });
      await expect(
        Promise.race([
          preparationWaitObserved.promise.then((rootPath) => ({ status: "waiting", rootPath })),
          prematureRootRemoval.promise.then((rootPath) => ({ status: "removed", rootPath })),
          secondAcquisition.then(
            () => ({ status: "settled" }),
            () => ({ status: "failed" }),
          ),
        ]),
      ).resolves.toEqual({ status: "waiting", rootPath: journal.rootPath });

      allowGenerationRename.resolve();
      await expect(firstRelease).resolves.toBeUndefined();
      secondLease = await secondAcquisition;
      const registry = JSON.parse(
        await readFile(path.join(root, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ id: string; sessionId: string; generationId: string }> };
      expect(registry.leases).toEqual([
        expect.objectContaining({
          id: "second-tab-lease",
          sessionId: "second-tab-lease-owner",
          generationId: "second-tab-lease-generation",
        }),
      ]);
      expect((await readdir(root)).filter((entry) => entry.includes(".released-"))).toEqual([]);
      expect(
        (await readdir(root)).filter(
          (entry) =>
            entry.startsWith(".oracle-remove-") ||
            entry.endsWith(".cleanup-journal.json") ||
            entry.endsWith(".contents-deleted.json"),
        ),
      ).toEqual([]);
      await expect(stat(journal.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });

      await secondLease.release();
      secondLease = undefined;
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      directoryRemovalTest.setBeforePreparationWait(undefined);
      allowGenerationRename.resolve();
      await Promise.allSettled([
        firstRelease ?? Promise.resolve(),
        secondAcquisition ?? Promise.resolve(),
      ]);
      await secondLease?.release().catch(() => undefined);
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("../../src/browser/filesystemLockIo.js");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.runIf(
    process.platform === "linux" || process.platform === "darwin" || process.platform === "win32",
  )("serializes concurrent removal of one journaled root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-bound-delete-race-"));
    const candidatePath = path.join(root, "candidate");
    await mkdir(path.join(candidatePath, "nested"), { recursive: true });
    await writeFile(path.join(candidatePath, "nested", "owned-marker"), "delete");
    const firstAttested = Promise.withResolvers<void>();
    const allowFirstRemoval = Promise.withResolvers<void>();
    const removals: Promise<void>[] = [];
    let secondHelperAttested = false;
    try {
      const isolation = await isolateDirectoryGenerationForRemoval(
        candidatePath,
        async (generationPath) => (await stat(generationPath)).isDirectory(),
      );
      expect(isolation.status).toBe("isolated");
      if (isolation.status !== "isolated") throw new Error("Expected isolated generation");

      const firstRemoval = removeIsolatedDirectoryGeneration(isolation.rootPath, {
        afterChildAttestation: async () => {
          firstAttested.resolve();
          await allowFirstRemoval.promise;
        },
      });
      removals.push(firstRemoval);
      await firstAttested.promise;
      const secondRemoval = removeIsolatedDirectoryGeneration(isolation.rootPath, {
        afterChildAttestation: () => {
          secondHelperAttested = true;
        },
      });
      removals.push(secondRemoval);
      expect(secondRemoval).toBe(firstRemoval);
      expect(secondHelperAttested).toBe(false);
      allowFirstRemoval.resolve();
      await expect(Promise.all(removals)).resolves.toEqual([undefined, undefined]);
      await expect(stat(isolation.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(candidatePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      allowFirstRemoval.resolve();
      await Promise.allSettled(removals);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bound deletion unlinks external directory links and stays pending when unsupported", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-device-boundary-"));
    const candidatePath = path.join(root, "candidate");
    const externalPath = path.join(root, "external");
    await mkdir(candidatePath);
    await mkdir(externalPath);
    await writeFile(path.join(externalPath, "preserve"), "outside-generation", "utf8");
    await symlink(
      externalPath,
      path.join(candidatePath, "external-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const generationDevice = (await lstat(candidatePath, { bigint: true })).dev;

    try {
      const isolation = await isolateDirectoryGenerationForRemoval(
        candidatePath,
        async (generationPath) => (await stat(generationPath)).isDirectory(),
      );
      expect(isolation.status).toBe("isolated");
      if (isolation.status !== "isolated") throw new Error("Expected isolated generation");

      let removalError: unknown;
      try {
        await removeIsolatedDirectoryGeneration(isolation.rootPath);
      } catch (error) {
        removalError = error;
      }
      if (
        process.platform === "linux" ||
        process.platform === "darwin" ||
        process.platform === "win32"
      ) {
        expect(removalError).toBeUndefined();
        expect(generationDevice).not.toBe(0n);
        await expect(stat(isolation.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const detail = String(removalError);
        expect(detail).toMatch(/descriptor-rooted directory api/i);
        expect(detail).toMatch(/exit 1 signal null/i);
        expect((await stat(isolation.rootPath)).isDirectory()).toBe(true);
        expect((await stat(`${isolation.rootPath}.cleanup-journal.json`)).isFile()).toBe(true);
      }
      await expect(readFile(path.join(externalPath, "preserve"), "utf8")).resolves.toBe(
        "outside-generation",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("malformed isolated cleanup journals fail closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-cleanup-journal-"));
    const lockPath = path.join(root, "recovery.lock");
    try {
      await mkdir(lockPath);
      const isolation = await isolateDirectoryGenerationForRemoval(
        lockPath,
        async () => true,
        lockPath,
      );
      expect(isolation.status).toBe("isolated");
      if (isolation.status !== "isolated") throw new Error("Expected isolated generation");
      const journalPath = `${isolation.rootPath}.cleanup-journal.json`;
      await writeFile(journalPath, "{not-json", "utf8");
      await expect(retryPendingFilesystemLockReleases(lockPath)).rejects.toThrow(
        /malformed cleanup authority json/i,
      );
      await expect(readFile(journalPath, "utf8")).resolves.toBe("{not-json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("legacy file quarantine replacement is preserved instead of deleted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-legacy-race-"));
    const lockPath = path.join(root, "oracle-automation.lock");
    const movedLegacyPath = path.join(root, "moved-legacy-lock");
    const legacyPid = 41_041;
    const legacyRaw = `${JSON.stringify({
      pid: legacyPid,
      lockId: "dead-legacy-generation",
      createdAt: new Date().toISOString(),
      sessionId: "legacy-session",
    })}\n`;
    const replacementRaw = `${JSON.stringify({
      pid: process.pid,
      lockId: "replacement-generation",
      createdAt: new Date().toISOString(),
      sessionId: "replacement-session",
    })}\n`;
    try {
      await writeFile(lockPath, legacyRaw, "utf8");
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          { timeoutMs: 150, pollMs: 10 },
          {
            processIdentityProvider: createProcessIdentityProvider(
              40_045,
              async () => "current-generation",
              (pid) => (pid === legacyPid ? "dead" : "alive"),
            ),
            afterStaleLockQuarantine: async (quarantinedPath) => {
              await rename(quarantinedPath, movedLegacyPath);
              await writeFile(quarantinedPath, replacementRaw, "utf8");
            },
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      await expect(readFile(movedLegacyPath, "utf8")).resolves.toBe(legacyRaw);
      await expect(readFile(lockPath, "utf8")).resolves.toBe(replacementRaw);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("directory quarantine rejects a physically replaced generation with a cloned owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-directory-race-"));
    const lockPath = path.join(root, "recovery.lock");
    const movedGeneration = path.join(root, "moved-original-generation");
    const stalePid = 41_141;
    const ownerRaw = `${JSON.stringify({
      version: 1,
      pid: stalePid,
      processStartIdentity: "stale-generation",
      ownerNonce: "cloned-owner",
      createdAt: new Date().toISOString(),
    })}\n`;
    let ownerAlive = false;
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), ownerRaw, "utf8");
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(
              40_145,
              async (pid) => (pid === stalePid ? "stale-generation" : "current-generation"),
              (pid) => (pid === stalePid ? (ownerAlive ? "alive" : "dead") : "alive"),
            ),
            afterStaleLockQuarantine: async (quarantinedPath) => {
              await rename(quarantinedPath, movedGeneration);
              await mkdir(quarantinedPath);
              await writeFile(path.join(quarantinedPath, "owner.json"), ownerRaw, "utf8");
              await writeFile(path.join(quarantinedPath, "replacement-marker"), "preserve", "utf8");
              ownerAlive = true;
            },
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      await expect(readFile(path.join(movedGeneration, "owner.json"), "utf8")).resolves.toBe(
        ownerRaw,
      );
      await expect(readFile(path.join(lockPath, "replacement-marker"), "utf8")).resolves.toBe(
        "preserve",
      );
      await expect(readFile(path.join(lockPath, "owner.json"), "utf8")).resolves.toBe(ownerRaw);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("legacy file with unknown pid liveness remains authoritative", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-legacy-unknown-"));
    const lockPath = path.join(root, "oracle-automation.lock");
    const legacyRaw = `${JSON.stringify({
      pid: 51_051,
      lockId: "unknown-legacy-generation",
      createdAt: new Date().toISOString(),
      sessionId: "unknown-session",
    })}\n`;
    try {
      await writeFile(lockPath, legacyRaw, "utf8");
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          { timeoutMs: 100, pollMs: 10 },
          {
            processIdentityProvider: createProcessIdentityProvider(
              40_046,
              async () => "current-generation",
              () => "unknown",
            ),
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      await expect(readFile(lockPath, "utf8")).resolves.toBe(legacyRaw);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
