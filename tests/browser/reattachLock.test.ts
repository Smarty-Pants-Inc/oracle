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
