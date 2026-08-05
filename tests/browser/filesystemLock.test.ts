import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
} from "../../src/browser/filesystemLock.js";
import type {
  CrashRecoverableFilesystemLock,
  FilesystemLockProcessIdentityProvider,
  ProcessLiveness,
} from "../../src/browser/filesystemLock.js";

async function agePath(targetPath: string, ageMs = 10_000): Promise<void> {
  const timestamp = new Date(Date.now() - ageMs);
  await utimes(targetPath, timestamp, timestamp);
}

function createProcessIdentityProvider(
  pid: number,
  readProcessStartIdentity: (pid: number) => Promise<string | null>,
  readProcessLiveness: (pid: number) => ProcessLiveness = () => "alive",
  platform: NodeJS.Platform = "linux",
): FilesystemLockProcessIdentityProvider {
  return { platform, pid, readProcessLiveness, readProcessStartIdentity };
}

describe("crash-recoverable filesystem lock", () => {
  test("fails before publishing a lock when process generation is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "missing-parent", "recovery.lock");
    try {
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(10_000, async () => null),
          },
        ),
      ).rejects.toThrow(/without a stable process generation/i);
      await expect(stat(path.dirname(lockPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires an injected Windows provider to report a stable generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "missing-parent", "recovery.lock");
    try {
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(
              10_004,
              async () => null,
              () => "alive",
              "win32",
            ),
          },
        ),
      ).rejects.toThrow(/without a stable process generation/i);
      await expect(stat(path.dirname(lockPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  test("reclaims a live pid whose process-start identity no longer matches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    try {
      const original = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            42_042,
            async () => "original-start",
          ),
        },
      );
      const replacement = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(43_043, async (pid) =>
            pid === 42_042 ? "reused-pid-start" : "replacement-start",
          ),
        },
      );

      const replacementOwner = await readFile(path.join(lockPath, "owner.json"), "utf8");
      await expect(original.release()).rejects.toThrow(/ownership changed/i);
      expect(await readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(replacementOwner);
      await replacement.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes replacement and exact-owner release after the second stale inspection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const mutationRootPath = `${lockPath}.mutations`;
    const originalPid = 46_046;
    const reclaimerPid = 47_047;
    const replacementPid = 48_048;
    let resumeBeforeQuarantine!: () => void;
    const allowQuarantine = new Promise<void>((resolve) => {
      resumeBeforeQuarantine = resolve;
    });
    let markBeforeQuarantine!: () => void;
    const beforeQuarantine = new Promise<void>((resolve) => {
      markBeforeQuarantine = resolve;
    });
    let resumeAfterQuarantine!: () => void;
    const allowQuarantineCompletion = new Promise<void>((resolve) => {
      resumeAfterQuarantine = resolve;
    });
    let markAfterQuarantine!: () => void;
    const afterQuarantine = new Promise<void>((resolve) => {
      markAfterQuarantine = resolve;
    });
    let markReplacementPrepared!: () => void;
    const replacementPrepared = new Promise<void>((resolve) => {
      markReplacementPrepared = resolve;
    });
    let resumeReplacementTicket!: () => void;
    const allowReplacementTicket = new Promise<void>((resolve) => {
      resumeReplacementTicket = resolve;
    });
    let markReplacementRequestPublished!: () => void;
    const replacementRequestPublished = new Promise<void>((resolve) => {
      markReplacementRequestPublished = resolve;
    });
    let quarantinedPath: string | undefined;
    let reclaimerLock: CrashRecoverableFilesystemLock | undefined;
    let replacement: CrashRecoverableFilesystemLock | undefined;
    let releaseAttempt: Promise<void> | undefined;
    let replacementAcquire: Promise<CrashRecoverableFilesystemLock> | undefined;
    let reclaimerRemovalAttempts = 0;

    const identities: Record<number, string> = {
      [originalPid]: "original-start",
      [reclaimerPid]: "reclaimer-start",
      [replacementPid]: "replacement-start",
    };
    const original = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(
          originalPid,
          async (pid) => identities[pid] ?? null,
        ),
      },
    );
    const reclaimer = acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(reclaimerPid, async (pid) =>
          pid === originalPid ? "reused-original-pid" : (identities[pid] ?? null),
        ),
        beforeStaleLockQuarantine: async () => {
          markBeforeQuarantine();
          await allowQuarantine;
        },
        afterStaleLockQuarantine: async (stalePath) => {
          quarantinedPath = stalePath;
          markAfterQuarantine();
          await allowQuarantineCompletion;
        },
        beforeMutationRequestRemoval: async () => {
          reclaimerRemovalAttempts += 1;
          if (reclaimerRemovalAttempts === 1) {
            throw new Error("injected mutation request cleanup failure");
          }
        },
      },
    );

    try {
      await beforeQuarantine;
      const originalOwnerRaw = await readFile(path.join(lockPath, "owner.json"), "utf8");

      replacementAcquire = acquireCrashRecoverableFilesystemLock(
        lockPath,
        { timeoutMs: 5_000, pollMs: 10 },
        {
          processIdentityProvider: createProcessIdentityProvider(replacementPid, async (pid) =>
            pid === originalPid ? "reused-original-pid" : (identities[pid] ?? null),
          ),
          beforeLockPublication: async () => {
            markReplacementPrepared();
          },
          beforeMutationRequestTicketPublication: async () => {
            markReplacementRequestPublished();
            await allowReplacementTicket;
          },
        },
      );
      await replacementPrepared;
      await replacementRequestPublished;
      await vi.waitFor(
        async () => {
          const requests = (await readdir(mutationRootPath)).filter((entry) =>
            entry.startsWith("request-"),
          );
          expect(requests).toHaveLength(2);
        },
        { timeout: 10_000, interval: 10 },
      );
      expect(await readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(originalOwnerRaw);

      resumeBeforeQuarantine();
      await afterQuarantine;
      expect(quarantinedPath).toBeDefined();
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(quarantinedPath!)).isDirectory()).toBe(true);

      let releaseSettled = false;
      releaseAttempt = original.release().finally(() => {
        releaseSettled = true;
      });
      void releaseAttempt.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const requests = (await readdir(mutationRootPath)).filter((entry) =>
            entry.startsWith("request-"),
          );
          expect(requests).toHaveLength(3);
        },
        { timeout: 10_000, interval: 10 },
      );
      expect(releaseSettled).toBe(false);

      resumeReplacementTicket();
      resumeAfterQuarantine();
      reclaimerLock = await reclaimer;
      await expect(releaseAttempt).rejects.toThrow(/ownership changed/i);

      await expect(reclaimerLock.release()).rejects.toThrow(
        "injected mutation request cleanup failure",
      );
      expect(reclaimerRemovalAttempts).toBe(1);

      replacement = await replacementAcquire;
      const replacementOwnerRaw = await readFile(path.join(lockPath, "owner.json"), "utf8");
      expect(JSON.parse(replacementOwnerRaw)).toMatchObject({
        ownerNonce: replacement.owner.ownerNonce,
        pid: replacementPid,
      });
      const requestsAfterFailedCleanup = await readdir(mutationRootPath);
      const activeRequestsAfterFailedCleanup = requestsAfterFailedCleanup.filter(
        (entry) => entry.startsWith("request-") && !entry.includes(".stale-"),
      );
      expect(activeRequestsAfterFailedCleanup).toHaveLength(1);
      expect(
        JSON.parse(
          await readFile(
            path.join(mutationRootPath, activeRequestsAfterFailedCleanup[0]!, "owner.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ pid: replacementPid });
      const quarantinedRequestsAfterFailedCleanup = requestsAfterFailedCleanup.filter(
        (entry) => entry.startsWith("request-") && entry.includes(".stale-"),
      );
      expect(quarantinedRequestsAfterFailedCleanup).toHaveLength(1);
      expect(
        JSON.parse(
          await readFile(
            path.join(mutationRootPath, quarantinedRequestsAfterFailedCleanup[0]!, "owner.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ pid: reclaimerPid });

      await expect(reclaimerLock.release()).resolves.toBeUndefined();
      expect(reclaimerRemovalAttempts).toBe(2);
      await expect(readFile(path.join(lockPath, "owner.json"), "utf8")).resolves.toBe(
        replacementOwnerRaw,
      );
      expect(
        (await readdir(mutationRootPath)).filter(
          (entry) => entry.startsWith("request-") && !entry.includes(".stale-"),
        ),
      ).toEqual(activeRequestsAfterFailedCleanup);
      await expect(reclaimerLock.release()).resolves.toBeUndefined();
      expect(reclaimerRemovalAttempts).toBe(2);
      reclaimerLock = undefined;

      const observedOwner = JSON.parse(replacementOwnerRaw) as { ownerNonce: string };
      expect(observedOwner.ownerNonce).toBe(replacement.owner.ownerNonce);
      expect(
        (await readdir(root)).filter(
          (entry) => entry.startsWith("recovery.lock.stale-") || entry.includes(".released-"),
        ),
      ).toEqual([]);

      await replacement.release();
      await replacement.release();
      replacement = undefined;
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(mutationRootPath)).toEqual([]);
    } finally {
      resumeBeforeQuarantine();
      resumeReplacementTicket();
      resumeAfterQuarantine();
      await Promise.allSettled(
        [reclaimer, replacementAcquire, releaseAttempt].filter(Boolean) as Promise<unknown>[],
      );
      await replacement?.release().catch(() => undefined);
      await reclaimerLock?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a stalled private publisher cannot alter a successor generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const stalledPid = 48_048;
    const successorPid = 49_049;
    const identities: Record<number, string> = {
      [stalledPid]: "stalled-start",
      [successorPid]: "successor-start",
    };
    let resumeStalledPublisher!: () => void;
    const allowStalledPublisher = new Promise<void>((resolve) => {
      resumeStalledPublisher = resolve;
    });
    let markStalledPublisherReady!: () => void;
    const stalledPublisherReady = new Promise<void>((resolve) => {
      markStalledPublisherReady = resolve;
    });
    let preparedLockPath: string | undefined;
    let successor: CrashRecoverableFilesystemLock | undefined;

    const stalledAcquire = acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(
          stalledPid,
          async (pid) => identities[pid] ?? null,
        ),
        beforeLockPublication: async (privatePath) => {
          preparedLockPath = privatePath;
          markStalledPublisherReady();
          await allowStalledPublisher;
        },
      },
    );

    try {
      await stalledPublisherReady;
      expect(preparedLockPath).toBeDefined();
      expect(path.dirname(preparedLockPath!)).toBe(root);
      expect(path.basename(preparedLockPath!)).toMatch(/^recovery\.lock\.publishing-/u);
      expect(
        JSON.parse(await readFile(path.join(preparedLockPath!, "owner.json"), "utf8")),
      ).toMatchObject({ pid: stalledPid, processStartIdentity: "stalled-start" });
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

      successor = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            successorPid,
            async (pid) => identities[pid] ?? null,
          ),
        },
      );
      const successorOwnerRaw = await readFile(path.join(lockPath, "owner.json"), "utf8");

      resumeStalledPublisher();
      await expect(stalledAcquire).rejects.toBeInstanceOf(FilesystemLockBusyError);
      expect(await readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(successorOwnerRaw);
      expect((await stat(lockPath)).isDirectory()).toBe(true);
      expect(
        (await readdir(root)).filter((entry) => entry.startsWith("recovery.lock.publishing-")),
      ).toEqual([]);

      await successor.release();
      successor = undefined;
    } finally {
      resumeStalledPublisher();
      await stalledAcquire.catch(() => undefined);
      await successor?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not expose an ownerless mutation request before ticket publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const originalPid = 53_053;
    const stalledPid = 54_054;
    const contenderPid = 55_055;
    let resumeOwnerWrite!: () => void;
    const allowOwnerWrite = new Promise<void>((resolve) => {
      resumeOwnerWrite = resolve;
    });
    let markOwnerWriteBlocked!: () => void;
    const ownerWriteBlocked = new Promise<void>((resolve) => {
      markOwnerWriteBlocked = resolve;
    });
    let resumeContender!: () => void;
    const allowContender = new Promise<void>((resolve) => {
      resumeContender = resolve;
    });
    let markContenderReady!: () => void;
    const contenderReady = new Promise<void>((resolve) => {
      markContenderReady = resolve;
    });
    let stalledPreparedPath: string | undefined;
    let stalledRequestPath: string | undefined;
    let stalledLock: CrashRecoverableFilesystemLock | undefined;
    let contenderLock: CrashRecoverableFilesystemLock | undefined;
    const identities: Record<number, string> = {
      [originalPid]: "original-start",
      [stalledPid]: "stalled-start",
      [contenderPid]: "contender-start",
    };
    await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(
          originalPid,
          async (pid) => identities[pid] ?? null,
        ),
      },
    );
    const stalledAcquire = acquireCrashRecoverableFilesystemLock(
      lockPath,
      { timeoutMs: 5_000, pollMs: 10 },
      {
        processIdentityProvider: createProcessIdentityProvider(stalledPid, async (pid) =>
          pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
        ),
        beforeMutationRequestOwnerWrite: async (preparedPath, requestPath) => {
          stalledPreparedPath = preparedPath;
          stalledRequestPath = requestPath;
          markOwnerWriteBlocked();
          await allowOwnerWrite;
        },
      },
    );

    let contenderAcquire: Promise<CrashRecoverableFilesystemLock> | undefined;
    try {
      await ownerWriteBlocked;
      expect(stalledPreparedPath).toBeDefined();
      expect(stalledRequestPath).toBeDefined();
      expect(await readFile(path.join(stalledPreparedPath!, "owner.json"), "utf8")).toBe("");
      await expect(stat(stalledRequestPath!)).rejects.toMatchObject({ code: "ENOENT" });

      contenderAcquire = acquireCrashRecoverableFilesystemLock(
        lockPath,
        { timeoutMs: 5_000, pollMs: 10 },
        {
          processIdentityProvider: createProcessIdentityProvider(contenderPid, async (pid) =>
            pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
          ),
          beforeStaleLockQuarantine: async () => {
            markContenderReady();
            await allowContender;
          },
        },
      );
      await contenderReady;
      expect((await stat(stalledPreparedPath!)).isDirectory()).toBe(true);
      expect(await readFile(path.join(stalledPreparedPath!, "owner.json"), "utf8")).toBe("");
      await expect(stat(stalledRequestPath!)).rejects.toMatchObject({ code: "ENOENT" });

      resumeOwnerWrite();
      await vi.waitFor(async () => {
        expect(await readFile(path.join(stalledRequestPath!, "ticket"), "utf8")).toMatch(
          /^[1-9]\d*\n$/u,
        );
      });
      expect((await stat(stalledRequestPath!)).isDirectory()).toBe(true);

      resumeContender();
      contenderLock = await contenderAcquire;
      await contenderLock.release();
      contenderLock = undefined;

      stalledLock = await stalledAcquire;
      expect(stalledLock.owner.pid).toBe(stalledPid);
      await stalledLock.release();
      stalledLock = undefined;
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resumeOwnerWrite();
      resumeContender();
      await Promise.allSettled(
        [stalledAcquire, contenderAcquire].filter(Boolean) as Promise<unknown>[],
      );
      await contenderLock?.release().catch(() => undefined);
      await stalledLock?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serializes equal tickets behind a complete doorway", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const mutationRootPath = `${lockPath}.mutations`;
    const originalPid = 56_056;
    const firstPid = 57_057;
    const secondPid = 58_058;
    let resumeFirstTicket!: () => void;
    const allowFirstTicket = new Promise<void>((resolve) => {
      resumeFirstTicket = resolve;
    });
    let markFirstTicketBlocked!: () => void;
    const firstTicketBlocked = new Promise<void>((resolve) => {
      markFirstTicketBlocked = resolve;
    });
    let resumeFirstMutation!: () => void;
    const allowFirstMutation = new Promise<void>((resolve) => {
      resumeFirstMutation = resolve;
    });
    let markFirstMutationReady!: () => void;
    const firstMutationReady = new Promise<void>((resolve) => {
      markFirstMutationReady = resolve;
    });
    let firstNonceIndex = 0;
    let secondNonceIndex = 0;
    const firstNonces = ["first-lock", "000-first-request", "first-quarantine"];
    const secondNonces = ["second-lock", "fff-second-request", "second-quarantine"];
    const identities: Record<number, string> = {
      [originalPid]: "original-start",
      [firstPid]: "first-start",
      [secondPid]: "second-start",
    };
    let firstLock: CrashRecoverableFilesystemLock | undefined;
    let secondLock: CrashRecoverableFilesystemLock | undefined;
    let secondSettled = false;
    await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(
          originalPid,
          async (pid) => identities[pid] ?? null,
        ),
      },
    );
    const firstAcquire = acquireCrashRecoverableFilesystemLock(
      lockPath,
      { timeoutMs: 5_000, pollMs: 10 },
      {
        processIdentityProvider: createProcessIdentityProvider(firstPid, async (pid) =>
          pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
        ),
        randomUUID: () => firstNonces[firstNonceIndex++] ?? `first-${firstNonceIndex}`,
        beforeMutationRequestTicketPublication: async (_requestPath, ticket) => {
          expect(ticket).toBe(1);
          markFirstTicketBlocked();
          await allowFirstTicket;
        },
        beforeStaleLockQuarantine: async () => {
          markFirstMutationReady();
          await allowFirstMutation;
        },
      },
    );

    let secondAcquire: Promise<CrashRecoverableFilesystemLock> | undefined;
    try {
      await firstTicketBlocked;
      const firstRequestPath = path.join(mutationRootPath, "request-000-first-request");
      const secondRequestPath = path.join(mutationRootPath, "request-fff-second-request");
      expect(await readFile(path.join(firstRequestPath, "owner.json"), "utf8")).not.toBe("");
      await expect(stat(path.join(firstRequestPath, "ticket"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      secondAcquire = acquireCrashRecoverableFilesystemLock(
        lockPath,
        { timeoutMs: 5_000, pollMs: 10 },
        {
          processIdentityProvider: createProcessIdentityProvider(secondPid, async (pid) =>
            pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
          ),
          randomUUID: () => secondNonces[secondNonceIndex++] ?? `second-${secondNonceIndex}`,
        },
      ).finally(() => {
        secondSettled = true;
      });
      void secondAcquire.catch(() => undefined);
      await vi.waitFor(async () => {
        expect(await readFile(path.join(secondRequestPath, "ticket"), "utf8")).toBe("1\n");
      });
      expect(secondSettled).toBe(false);

      resumeFirstTicket();
      await firstMutationReady;
      expect(await readFile(path.join(firstRequestPath, "ticket"), "utf8")).toBe("1\n");
      expect(secondSettled).toBe(false);

      resumeFirstMutation();
      firstLock = await firstAcquire;
      expect(secondSettled).toBe(false);
      await firstLock.release();
      firstLock = undefined;

      secondLock = await secondAcquire;
      await secondLock.release();
      secondLock = undefined;
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(mutationRootPath)).toEqual([]);
    } finally {
      resumeFirstTicket();
      resumeFirstMutation();
      await Promise.allSettled([firstAcquire, secondAcquire].filter(Boolean) as Promise<unknown>[]);
      await secondLock?.release().catch(() => undefined);
      await firstLock?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("finishes timed-out queue cleanup before rejecting acquisition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const mutationRootPath = `${lockPath}.mutations`;
    const originalPid = 50_050;
    const blockerPid = 51_051;
    const contenderPid = 52_052;
    let resumeBlocker!: () => void;
    const allowBlocker = new Promise<void>((resolve) => {
      resumeBlocker = resolve;
    });
    let markBlockerReady!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      markBlockerReady = resolve;
    });
    let resumeCleanup!: () => void;
    const allowCleanup = new Promise<void>((resolve) => {
      resumeCleanup = resolve;
    });
    let markCleanupBlocked!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      markCleanupBlocked = resolve;
    });
    let blockerLock: CrashRecoverableFilesystemLock | undefined;
    let timedAcquire: Promise<CrashRecoverableFilesystemLock> | undefined;
    let cleanupAttempts = 0;
    let timedAcquireSettled = false;
    const identities: Record<number, string> = {
      [originalPid]: "original-start",
      [blockerPid]: "blocker-start",
      [contenderPid]: "contender-start",
    };
    await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(
          originalPid,
          async (pid) => identities[pid] ?? null,
        ),
      },
    );
    const blocker = acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(blockerPid, async (pid) =>
          pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
        ),
        beforeStaleLockQuarantine: async () => {
          markBlockerReady();
          await allowBlocker;
        },
      },
    );

    try {
      await blockerReady;
      timedAcquire = acquireCrashRecoverableFilesystemLock(
        lockPath,
        { timeoutMs: 20, pollMs: 10 },
        {
          processIdentityProvider: createProcessIdentityProvider(contenderPid, async (pid) =>
            pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
          ),
          beforeMutationRequestRemoval: async () => {
            cleanupAttempts += 1;
            if (cleanupAttempts === 1) {
              throw Object.assign(new Error("injected transient request cleanup failure"), {
                code: "EINTR",
              });
            }
            markCleanupBlocked();
            await allowCleanup;
          },
        },
      ).finally(() => {
        timedAcquireSettled = true;
      });
      void timedAcquire.catch(() => undefined);

      await cleanupBlocked;
      expect(cleanupAttempts).toBe(2);
      expect(timedAcquireSettled).toBe(false);
      expect(
        (await readdir(mutationRootPath)).filter((entry) => entry.startsWith("request-")),
      ).toHaveLength(2);

      resumeCleanup();
      await expect(timedAcquire).rejects.toBeInstanceOf(FilesystemLockBusyError);
      expect(timedAcquireSettled).toBe(true);
      expect(
        (await readdir(mutationRootPath)).filter((entry) => entry.startsWith("request-")),
      ).toHaveLength(1);

      resumeBlocker();
      blockerLock = await blocker;
      await blockerLock.release();
      blockerLock = undefined;
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resumeCleanup();
      resumeBlocker();
      await Promise.allSettled([blocker, timedAcquire].filter(Boolean) as Promise<unknown>[]);
      await blockerLock?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const code of ["EACCES", "EROFS"] as const) {
    test(`surfaces persistent ${code} cleanup after hiding only its exact request`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
      const lockPath = path.join(root, "recovery.lock");
      const mutationRootPath = `${lockPath}.mutations`;
      const originalPid = 56_056;
      const blockerPid = 57_057;
      const contenderPid = 58_058;
      let resumeBlocker!: () => void;
      const allowBlocker = new Promise<void>((resolve) => {
        resumeBlocker = resolve;
      });
      let markBlockerReady!: () => void;
      const blockerReady = new Promise<void>((resolve) => {
        markBlockerReady = resolve;
      });
      let blockerLock: CrashRecoverableFilesystemLock | undefined;
      let cleanupAttempts = 0;
      const identities: Record<number, string> = {
        [originalPid]: "original-start",
        [blockerPid]: "blocker-start",
        [contenderPid]: "contender-start",
      };
      await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            originalPid,
            async (pid) => identities[pid] ?? null,
          ),
        },
      );
      const blocker = acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(blockerPid, async (pid) =>
            pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
          ),
          beforeStaleLockQuarantine: async () => {
            markBlockerReady();
            await allowBlocker;
          },
        },
      );

      try {
        await blockerReady;
        const activeBefore = (await readdir(mutationRootPath)).filter(
          (entry) => entry.startsWith("request-") && !entry.includes(".stale-"),
        );
        expect(activeBefore).toHaveLength(1);

        await expect(
          acquireCrashRecoverableFilesystemLock(
            lockPath,
            { timeoutMs: 20, pollMs: 10 },
            {
              processIdentityProvider: createProcessIdentityProvider(contenderPid, async (pid) =>
                pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
              ),
              beforeMutationRequestRemoval: async () => {
                cleanupAttempts += 1;
                throw Object.assign(new Error(`persistent cleanup ${code}`), { code });
              },
            },
          ),
        ).rejects.toMatchObject({ code });
        expect(cleanupAttempts).toBe(1);

        const entries = await readdir(mutationRootPath);
        const activeAfter = entries.filter(
          (entry) => entry.startsWith("request-") && !entry.includes(".stale-"),
        );
        expect(activeAfter).toEqual(activeBefore);
        expect(
          JSON.parse(
            await readFile(path.join(mutationRootPath, activeAfter[0]!, "owner.json"), "utf8"),
          ),
        ).toMatchObject({ pid: blockerPid });

        const quarantined = entries.filter(
          (entry) => entry.startsWith("request-") && entry.includes(".stale-"),
        );
        expect(quarantined).toHaveLength(1);
        expect(
          JSON.parse(
            await readFile(path.join(mutationRootPath, quarantined[0]!, "owner.json"), "utf8"),
          ),
        ).toMatchObject({ pid: contenderPid });

        resumeBlocker();
        blockerLock = await blocker;
        await blockerLock.release();
        blockerLock = undefined;
      } finally {
        resumeBlocker();
        await blocker.catch(() => undefined);
        await blockerLock?.release().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("does not reclaim a live owner when process-start identity lookup is ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    try {
      const original = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            44_044,
            async () => "original-start",
          ),
        },
      );

      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(45_045, async (pid) =>
              pid === 44_044 ? null : "replacement-start",
            ),
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      await original.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["darwin", "darwin-current-start", 70_001],
    ["linux", "linux-current-start", 70_002],
    ["win32", "win32-current-start", 70_003],
  ] as const)(
    "uses one injected %s process identity for lock ownership and mutation coordination",
    async (platform, currentStartIdentity, currentPid) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
      const lockPath = path.join(root, "recovery.lock");
      const originalPid = currentPid + 100;
      const readProcessLiveness = vi.fn((_pid: number): ProcessLiveness => "alive");
      const readProcessStartIdentity = vi.fn(async (pid: number) =>
        pid === originalPid ? "reused-original-start" : currentStartIdentity,
      );
      let mutationOwner: { pid: number; processStartIdentity: string | null } | undefined;

      try {
        await mkdir(lockPath);
        await writeFile(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({
            version: 1,
            pid: originalPid,
            processStartIdentity: "original-start",
            ownerNonce: "original-owner",
            createdAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );

        const lock = await acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(
              currentPid,
              readProcessStartIdentity,
              readProcessLiveness,
              platform,
            ),
            beforeMutationRequestTicketPublication: async (requestPath) => {
              mutationOwner = JSON.parse(
                await readFile(path.join(requestPath, "owner.json"), "utf8"),
              ) as { pid: number; processStartIdentity: string | null };
            },
          },
        );

        expect(lock.owner).toMatchObject({
          pid: currentPid,
          processStartIdentity: currentStartIdentity,
        });
        expect(mutationOwner).toMatchObject({
          pid: currentPid,
          processStartIdentity: currentStartIdentity,
        });
        expect(readProcessLiveness).toHaveBeenCalledWith(originalPid);
        expect(readProcessStartIdentity).toHaveBeenCalledWith(currentPid);
        expect(readProcessStartIdentity).toHaveBeenCalledWith(originalPid);
        await lock.release();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("preserves a null-generation lock while its owner pid is alive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    let ownerAlive = true;
    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          version: 1,
          pid: 62_062,
          processStartIdentity: null,
          ownerNonce: "timed-out-current-owner",
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      const deps = {
        processIdentityProvider: createProcessIdentityProvider(
          63_063,
          async () => "replacement-start",
          (pid) => (pid === 62_062 && ownerAlive ? "alive" : "dead"),
        ),
      };
      await expect(
        acquireCrashRecoverableFilesystemLock(lockPath, {}, deps),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      ownerAlive = false;
      const replacement = await acquireCrashRecoverableFilesystemLock(lockPath, {}, deps);
      await replacement.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
