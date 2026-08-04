import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
} from "../../src/browser/filesystemLock.js";

async function agePath(targetPath: string, ageMs = 10_000): Promise<void> {
  const timestamp = new Date(Date.now() - ageMs);
  await utimes(targetPath, timestamp, timestamp);
}

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
            readProcessStartIdentity: async () => null,
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

  test("preserves a replacement generation classified after the stale owner was read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const originalPid = 46_046;
    const replacementPid = 47_047;
    let releaseSecondInspection!: () => void;
    const allowSecondInspection = new Promise<void>((resolve) => {
      releaseSecondInspection = resolve;
    });
    let markSecondInspectionStarted!: () => void;
    const secondInspectionStarted = new Promise<void>((resolve) => {
      markSecondInspectionStarted = resolve;
    });

    try {
      const original = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          pid: originalPid,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "original-start",
        },
      );

      let originalIdentityReads = 0;
      const racingAcquire = acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          pid: 48_048,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) => {
            if (pid === originalPid) {
              originalIdentityReads += 1;
              if (originalIdentityReads === 2) {
                markSecondInspectionStarted();
                await allowSecondInspection;
              }
              return "reused-original-pid";
            }
            if (pid === replacementPid) return "replacement-start";
            return "racing-contender-start";
          },
        },
      );
      await secondInspectionStarted;

      const replacement = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          pid: replacementPid,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) =>
            pid === originalPid ? "reused-original-pid" : "replacement-start",
        },
      );
      releaseSecondInspection();

      await expect(racingAcquire).rejects.toBeInstanceOf(FilesystemLockBusyError);
      const observedOwner = JSON.parse(
        await readFile(path.join(lockPath, "owner.json"), "utf8"),
      ) as { ownerNonce: string };
      expect(observedOwner.ownerNonce).toBe(replacement.owner.ownerNonce);
      await expect(original.release()).rejects.toThrow(/ownership changed/i);
      await replacement.release();
    } finally {
      releaseSecondInspection();
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
});
