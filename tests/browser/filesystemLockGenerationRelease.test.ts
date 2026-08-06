import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockReleasePendingError,
} from "../../src/browser/filesystemLock.js";
import type { CrashRecoverableFilesystemLock } from "../../src/browser/filesystemLock.js";
import {
  retryPendingFilesystemLockReleases,
  __test__ as releaseJournalTest,
} from "../../src/browser/filesystemLockReleaseJournal.js";
import { createProcessIdentityProvider } from "./filesystemLockTestHelpers.js";

describe("crash-recoverable filesystem lock", () => {
  test("treats an already-removed owned lock as released", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    try {
      const lock = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            40_040,
            async () => "original-start",
          ),
        },
      );
      await rm(lockPath, { recursive: true, force: false });

      await expect(lock.release()).resolves.toBeUndefined();
      await expect(lock.release()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds release behind a live stalled mutation and retains retry authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-release-"));
    const lockPath = path.join(root, "recovery.lock");
    const originalPid = 40_041;
    const blockerPid = 40_042;
    let resumeBlocker!: () => void;
    const allowBlocker = new Promise<void>((resolve) => {
      resumeBlocker = resolve;
    });
    let markBlockerReady!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      markBlockerReady = resolve;
    });
    const original = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(originalPid, async (pid) =>
          pid === blockerPid ? "blocker-start" : "original-start",
        ),
      },
    );
    const blocker = acquireCrashRecoverableFilesystemLock(
      lockPath,
      { timeoutMs: 5_000, pollMs: 10 },
      {
        processIdentityProvider: createProcessIdentityProvider(blockerPid, async (pid) =>
          pid === originalPid ? "reused-original-start" : "blocker-start",
        ),
        beforeStaleLockQuarantine: async () => {
          markBlockerReady();
          await allowBlocker;
          throw new Error("cancel stalled mutation");
        },
      },
    );
    void blocker.catch(() => undefined);

    try {
      await blockerReady;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const releaseDeadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("release exceeded bounded deadline")), 2_500);
      });
      try {
        await expect(Promise.race([original.release(), releaseDeadline])).rejects.toBeInstanceOf(
          FilesystemLockReleasePendingError,
        );
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      await expect(readFile(path.join(lockPath, "owner.json"), "utf8")).resolves.toContain(
        original.owner.ownerNonce,
      );

      resumeBlocker();
      await expect(blocker).rejects.toThrow("cancel stalled mutation");
      await expect(retryPendingFilesystemLockReleases(lockPath)).resolves.toBeUndefined();
    } finally {
      resumeBlocker();
      await blocker.catch(() => undefined);
      await original.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("adopts the exact current controller generation on the first retry after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-restart-"));
    const lockPath = path.join(root, "recovery.lock");
    const provider = createProcessIdentityProvider(40_043, async () => "controller-start");
    const original = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      { sessionId: "browser-recovery:test-generation" },
      { processIdentityProvider: provider, randomUUID: () => "original-owner" },
    );

    try {
      releaseJournalTest.clearRetainedFilesystemLockReleases();
      const adopted = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {
          sessionId: "browser-recovery:test-generation",
          adoptCurrentProcessGeneration: true,
        },
        { processIdentityProvider: provider, randomUUID: () => "replacement-owner" },
      );

      expect(adopted.owner).toEqual(original.owner);
      await adopted.release();
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("post-isolation cleanup failure hides mutation authority and retries one private root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-release-"));
    const lockPath = path.join(root, "recovery.lock");
    const mutationRootPath = `${lockPath}.mutations`;
    const isolatedRemovalRoots: string[] = [];
    let failCleanup = true;
    let mutationRequestPublications = 0;
    const original = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(
          40_043,
          async () => "original-start",
        ),
        beforeMutationRequestTicketPublication: async () => {
          mutationRequestPublications += 1;
        },
        beforeReleasedLockRemoval: async (isolatedRootPath) => {
          isolatedRemovalRoots.push(isolatedRootPath);
          if (failCleanup) {
            failCleanup = false;
            throw Object.assign(new Error("injected post-isolation cleanup failure"), {
              code: "EBUSY",
            });
          }
        },
      },
    );
    let successor: CrashRecoverableFilesystemLock | undefined;

    try {
      await expect(original.release()).rejects.toMatchObject({ code: "EBUSY" });
      expect(mutationRequestPublications).toBe(1);
      expect(isolatedRemovalRoots).toHaveLength(1);
      const isolatedRemovalRoot = isolatedRemovalRoots[0]!;
      expect(path.basename(isolatedRemovalRoot)).toMatch(/^\.oracle-remove-/u);
      expect((await stat(isolatedRemovalRoot)).isDirectory()).toBe(true);
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).filter((entry) => entry.includes(".released-"))).toEqual([]);
      expect(
        (await readdir(mutationRootPath)).filter(
          (entry) => entry.startsWith("request-") && !entry.includes(".stale-"),
        ),
      ).toEqual([]);

      releaseJournalTest.clearRetainedFilesystemLockReleases();
      successor = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        { timeoutMs: 1_000, pollMs: 10 },
        {
          processIdentityProvider: createProcessIdentityProvider(
            40_044,
            async () => "successor-start",
          ),
        },
      );
      expect(mutationRequestPublications).toBe(1);
      expect(isolatedRemovalRoots).toEqual([isolatedRemovalRoot]);
      await expect(stat(isolatedRemovalRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readdir(root)).filter((entry) => entry.endsWith(".cleanup-journal.json")),
      ).toEqual([]);
      const successorOwnerRaw = await readFile(path.join(lockPath, "owner.json"), "utf8");
      await expect(original.release()).resolves.toBeUndefined();
      expect(await readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(successorOwnerRaw);

      await successor.release();
      successor = undefined;
    } finally {
      await successor?.release().catch(() => undefined);
      await original.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
  test("release refuses a cloned owner record in a replacement directory generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-release-generation-"));
    const lockPath = path.join(root, "recovery.lock");
    const movedGeneration = path.join(root, "moved-owned-generation");
    const lock = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(40_142, async () => "owned-start"),
      },
    );
    try {
      const ownerRaw = await readFile(path.join(lockPath, "owner.json"), "utf8");
      await rename(lockPath, movedGeneration);
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), ownerRaw, "utf8");
      await writeFile(path.join(lockPath, "replacement-marker"), "preserve", "utf8");

      await expect(lock.release()).rejects.toThrow(/generation changed/i);
      await expect(readFile(path.join(lockPath, "replacement-marker"), "utf8")).resolves.toBe(
        "preserve",
      );
      await expect(readFile(path.join(movedGeneration, "owner.json"), "utf8")).resolves.toBe(
        ownerRaw,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("post-verification mutation quarantine replacement preserves unrelated data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-quarantine-race-"));
    const lockPath = path.join(root, "recovery.lock");
    const movedGeneration = path.join(root, "verified-mutation-generation");
    const nonces = ["owned-lock", "mutation-owner"];
    let nonceIndex = 0;
    let replacementPath: string | undefined;
    const lock = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(40_043, async () => "owned-start"),
        randomUUID: () => nonces[nonceIndex++] ?? `extra-${nonceIndex}`,
        beforeMutationRequestRemoval: async (requestPath) => {
          const quarantinedPath = `${requestPath}.stale-mutation-owner`;
          replacementPath = quarantinedPath;
          await rename(quarantinedPath, movedGeneration);
          await mkdir(quarantinedPath);
          await writeFile(path.join(quarantinedPath, "replacement-marker"), "never-delete");
        },
      },
    );

    try {
      await expect(lock.release()).rejects.toThrow(/mutation ownership changed/i);
      expect(
        JSON.parse(await readFile(path.join(movedGeneration, "owner.json"), "utf8")),
      ).toMatchObject({ ownerNonce: "mutation-owner" });
      expect(replacementPath).toBeDefined();
      await expect(
        readFile(path.join(replacementPath ?? "", "replacement-marker"), "utf8"),
      ).resolves.toBe("never-delete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
