import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
} from "../../src/browser/filesystemLock.js";
import type { CrashRecoverableFilesystemLock } from "../../src/browser/filesystemLock.js";

async function agePath(targetPath: string, ageMs = 10_000): Promise<void> {
  const timestamp = new Date(Date.now() - ageMs);
  await utimes(targetPath, timestamp, timestamp);
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
            pid: 10_000,
            readProcessStartIdentity: async () => null,
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
          pid: 10_001,
          readProcessStartIdentity: async () => "current-start",
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
            pid: 10_002,
            readProcessStartIdentity: async () => "current-start",
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);

      await agePath(ownerPath, 120_000);
      await agePath(lockPath, 120_000);
      const lock = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        { incompleteLockStaleMs: 60_000 },
        {
          pid: 10_002,
          readProcessStartIdentity: async () => "current-start",
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
            pid: 10_003,
            readProcessLiveness: (pid) => (pid === 41_041 ? "alive" : "dead"),
            readProcessStartIdentity: async (pid) =>
              pid === 41_041 ? null : "current-process-start",
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
          pid: 40_040,
          readProcessStartIdentity: async () => "original-start",
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
          pid: 42_042,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "original-start",
        },
      );
      const replacement = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          pid: 43_043,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) =>
            pid === 42_042 ? "reused-pid-start" : "replacement-start",
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
        pid: originalPid,
        readProcessLiveness: () => "alive",
        readProcessStartIdentity: async (pid) => identities[pid] ?? null,
      },
    );
    const reclaimer = acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        pid: reclaimerPid,
        readProcessLiveness: () => "alive",
        readProcessStartIdentity: async (pid) =>
          pid === originalPid ? "reused-original-pid" : (identities[pid] ?? null),
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
          pid: replacementPid,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) =>
            pid === originalPid ? "reused-original-pid" : (identities[pid] ?? null),
          beforeLockPublication: async () => {
            markReplacementPrepared();
          },
        },
      );
      await replacementPrepared;
      await vi.waitFor(async () => {
        const requests = (await readdir(mutationRootPath)).filter((entry) =>
          entry.startsWith("request-"),
        );
        expect(requests).toHaveLength(2);
      });
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
      await vi.waitFor(async () => {
        const requests = (await readdir(mutationRootPath)).filter((entry) =>
          entry.startsWith("request-"),
        );
        expect(requests).toHaveLength(3);
      });
      expect(releaseSettled).toBe(false);

      resumeAfterQuarantine();
      reclaimerLock = await reclaimer;
      await expect(releaseAttempt).rejects.toThrow(/ownership changed/i);

      await expect(reclaimerLock.release()).rejects.toThrow(
        "injected mutation request cleanup failure",
      );
      expect(reclaimerRemovalAttempts).toBe(1);
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readdir(mutationRootPath)).filter((entry) => entry.startsWith("request-")),
      ).toHaveLength(2);

      await expect(reclaimerLock.release()).resolves.toBeUndefined();
      expect(reclaimerRemovalAttempts).toBe(2);
      await expect(reclaimerLock.release()).resolves.toBeUndefined();
      expect(reclaimerRemovalAttempts).toBe(2);
      reclaimerLock = undefined;

      replacement = await replacementAcquire;
      const observedOwner = JSON.parse(
        await readFile(path.join(lockPath, "owner.json"), "utf8"),
      ) as { ownerNonce: string };
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
      resumeAfterQuarantine();
      await Promise.allSettled(
        [reclaimer, replacementAcquire, releaseAttempt].filter(Boolean) as Promise<unknown>[],
      );
      await replacement?.release().catch(() => undefined);
      await reclaimerLock?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

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
        pid: stalledPid,
        readProcessLiveness: () => "alive",
        readProcessStartIdentity: async (pid) => identities[pid] ?? null,
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
          pid: successorPid,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) => identities[pid] ?? null,
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
        pid: originalPid,
        readProcessLiveness: () => "alive",
        readProcessStartIdentity: async (pid) => identities[pid] ?? null,
      },
    );
    const stalledAcquire = acquireCrashRecoverableFilesystemLock(
      lockPath,
      { timeoutMs: 5_000, pollMs: 10 },
      {
        pid: stalledPid,
        readProcessLiveness: () => "alive",
        readProcessStartIdentity: async (pid) =>
          pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
        beforeMutationRequestOwnerWrite: async (requestPath) => {
          stalledRequestPath = requestPath;
          markOwnerWriteBlocked();
          await allowOwnerWrite;
        },
      },
    );

    let contenderAcquire: Promise<CrashRecoverableFilesystemLock> | undefined;
    try {
      await ownerWriteBlocked;
      expect(stalledRequestPath).toBeDefined();
      expect(await readFile(path.join(stalledRequestPath!, "owner.json"), "utf8")).toBe("");
      await expect(stat(path.join(stalledRequestPath!, "ticket"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      contenderAcquire = acquireCrashRecoverableFilesystemLock(
        lockPath,
        { timeoutMs: 5_000, pollMs: 10 },
        {
          pid: contenderPid,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) =>
            pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
          beforeStaleLockQuarantine: async () => {
            markContenderReady();
            await allowContender;
          },
        },
      );
      await contenderReady;
      expect((await stat(stalledRequestPath!)).isDirectory()).toBe(true);
      expect(await readFile(path.join(stalledRequestPath!, "owner.json"), "utf8")).toBe("");

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
        pid: originalPid,
        readProcessLiveness: () => "alive",
        readProcessStartIdentity: async (pid) => identities[pid] ?? null,
      },
    );
    const blocker = acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        pid: blockerPid,
        readProcessLiveness: () => "alive",
        readProcessStartIdentity: async (pid) =>
          pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
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
          pid: contenderPid,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) =>
            pid === originalPid ? "reused-original-start" : (identities[pid] ?? null),
          beforeMutationRequestRemoval: async () => {
            cleanupAttempts += 1;
            if (cleanupAttempts === 1) {
              throw new Error("injected timed-out request cleanup failure");
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

  test("does not reclaim a live owner when process-start identity lookup is ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    try {
      const original = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          pid: 44_044,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "original-start",
        },
      );

      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            pid: 45_045,
            readProcessLiveness: () => "alive",
            readProcessStartIdentity: async (pid) => (pid === 44_044 ? null : "replacement-start"),
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      await original.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not negative-cache a Windows process-generation timeout", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const timeoutError = Object.assign(new Error("PowerShell process probe timed out"), {
      code: "ETIMEDOUT",
      killed: false,
    });
    const killedTimeoutError = Object.assign(new Error("PowerShell process probe was killed"), {
      code: null,
      killed: true,
    });
    let attempt = 0;
    const execFile = vi.fn();
    const execFileAsync = vi.fn(async (..._args: unknown[]) => {
      if (++attempt === 1) throw timeoutError;
      if (attempt === 2) throw killedTimeoutError;
      return { stdout: "638000000000000000", stderr: "" };
    });
    Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
      value: execFileAsync,
    });

    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.resetModules();
      vi.doMock("node:child_process", () => ({ execFile }));
      // Reloading intentionally binds this test's mocked Windows child-process boundary.
      const { readProcessStartIdentity } = await import("../../src/browser/filesystemLock.js");

      await expect(readProcessStartIdentity(process.pid)).rejects.toMatchObject({
        code: "ETIMEDOUT",
        killed: false,
      });
      await expect(readProcessStartIdentity(process.pid)).rejects.toMatchObject({
        code: null,
        killed: true,
      });
      await expect(readProcessStartIdentity(process.pid)).resolves.toBe("win32:638000000000000000");
      expect(execFileAsync).toHaveBeenCalledTimes(3);
      expect(execFileAsync.mock.calls[0]?.[0]).toBe("powershell.exe");
      expect(execFileAsync.mock.calls[0]?.[2]).toMatchObject({ timeout: 12_000 });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    }
  });
});
