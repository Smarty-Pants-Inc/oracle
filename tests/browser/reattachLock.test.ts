import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { retryBrowserRecoveryCleanup } from "../../src/browser/reattach.js";
import { acquireReattachRecoveryLock } from "../../src/browser/reattachLock.js";
import {
  retainFilesystemLockRelease,
  __test__ as releaseJournalTest,
} from "../../src/browser/filesystemLockReleaseJournal.js";

describe("reattach recovery lock authority", () => {
  test("completes a retained pending release before the next acquisition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    let attempts = 0;
    const retained = retainFilesystemLockRelease(
      lockPath,
      { pid: process.pid, processStartIdentity: "test-controller", ownerNonce: "pending-owner" },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("injected pending release");
      },
    );

    try {
      await expect(retained.release()).rejects.toThrow("injected pending release");
      const lock = await acquireReattachRecoveryLock(lockPath);
      expect(attempts).toBe(2);
      await lock.release();
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseJournalTest.clearRetainedFilesystemLockReleases();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries retained durable completion without repeating physical release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    let releaseAttempts = 0;
    let completionAttempts = 0;
    const retained = retainFilesystemLockRelease(
      lockPath,
      { pid: process.pid, processStartIdentity: "test-controller", ownerNonce: "pending-owner" },
      async () => {
        releaseAttempts += 1;
      },
    );

    try {
      await expect(
        retained.release(async () => {
          completionAttempts += 1;
          if (completionAttempts === 1) throw new Error("injected durable completion failure");
        }),
      ).rejects.toThrow("injected durable completion failure");

      const lock = await acquireReattachRecoveryLock(lockPath);
      expect(releaseAttempts).toBe(1);
      expect(completionAttempts).toBe(2);
      await lock.release();
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseJournalTest.clearRetainedFilesystemLockReleases();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows only one simultaneous same-process acquisition per canonical path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-lock-"));
    const lockPath = path.join(root, "recovery.lock");

    try {
      const results = await Promise.allSettled([
        acquireReattachRecoveryLock(lockPath),
        acquireReattachRecoveryLock(`${root}/nested/../recovery.lock`),
      ]);
      const acquired = results.find((result) => result.status === "fulfilled");
      const rejected = results.find((result) => result.status === "rejected");

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("current controller generation"),
        }),
      });
      if (!acquired || acquired.status !== "fulfilled") throw new Error("lock was not acquired");
      await acquired.value.release();
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseJournalTest.clearRetainedFilesystemLockReleases();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retains the exact settlement mode when lock release is still pending", async () => {
    const result = await retryBrowserRecoveryCleanup(
      {
        recoveryCleanupResult: {
          status: "failed",
          error: "prior abort cleanup",
          settlementMode: "abort",
        },
      },
      () => undefined,
      {
        acquireRecoveryLock: async () => {
          throw new Error("pending exact release");
        },
      },
      "abort",
    );

    expect(result).toMatchObject({
      status: "pending",
      runtime: {
        recoveryCleanupResult: {
          status: "failed",
          settlementMode: "abort",
        },
      },
    });
  });
});
