import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { retryBrowserRecoveryCleanup } from "../../src/browser/reattach.js";
import { acquireReattachRecoveryLock as acquireReattachRecoveryLockExact } from "../../src/browser/reattachLock.js";
import {
  establishPrivateRuntimeAuthority,
  type PrivateDirectoryAuthority,
} from "../../src/privateTempRoot.js";
import { capturePhysicalDirectoryIdentity } from "../../src/browser/filesystemLockDirectoryIdentity.js";
import {
  retainFilesystemLockRelease,
  __test__ as releaseJournalTest,
} from "../../src/browser/filesystemLockReleaseJournal.js";
import { testWindowsPrivateDirectoryAuthority } from "../privateAuthorityTestHelpers.js";
import { testProcessIdentityProvider } from "./filesystemLockTestHelpers.js";

const acquireReattachRecoveryLock = (
  lockPath: string,
  parentAuthority?: PrivateDirectoryAuthority,
) =>
  acquireReattachRecoveryLockExact(lockPath, parentAuthority, {
    processIdentityProvider: testProcessIdentityProvider,
  });

describe("reattach recovery lock authority", () => {
  test("completes a retained pending release before the next acquisition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-lock-"));
    const authority = await establishPrivateRuntimeAuthority({
      tempDirectory: root,
      windowsPrivateDirectoryAuthority: testWindowsPrivateDirectoryAuthority,
    });
    const lockPath = path.join(authority.path, "recovery.lock");
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
      const lock = await acquireReattachRecoveryLock(lockPath, authority);
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
    const authority = await establishPrivateRuntimeAuthority({
      tempDirectory: root,
      windowsPrivateDirectoryAuthority: testWindowsPrivateDirectoryAuthority,
    });
    const lockPath = path.join(authority.path, "recovery.lock");
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

      const lock = await acquireReattachRecoveryLock(lockPath, authority);
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
    const authority = await establishPrivateRuntimeAuthority({
      tempDirectory: root,
      windowsPrivateDirectoryAuthority: testWindowsPrivateDirectoryAuthority,
    });
    const lockPath = path.join(authority.path, "recovery.lock");

    try {
      const results = await Promise.allSettled([
        acquireReattachRecoveryLock(lockPath, authority),
        acquireReattachRecoveryLock(`${authority.path}/nested/../recovery.lock`, authority),
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

  test.skipIf(process.platform === "win32")(
    "rejects a world-writable shared parent and fails release after parent substitution",
    async () => {
      const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-parent-authority-"));
      const shared = path.join(ambient, "shared");
      await mkdir(shared);
      await chmod(shared, 0o777);
      const sharedAuthority: PrivateDirectoryAuthority = {
        path: shared,
        identity: await capturePhysicalDirectoryIdentity(shared),
        platform: process.platform,
      };
      await expect(
        acquireReattachRecoveryLock(path.join(shared, "recovery.lock"), sharedAuthority),
      ).rejects.toThrow(/private temporary directory authority changed/i);

      const authority = await establishPrivateRuntimeAuthority({ tempDirectory: ambient });
      const lockPath = path.join(authority.path, "recovery.lock");
      const lock = await acquireReattachRecoveryLock(lockPath, authority);
      const moved = `${authority.path}-moved`;
      await rename(authority.path, moved);
      await mkdir(authority.path, { mode: 0o700 });
      try {
        await expect(lock.release()).rejects.toThrow(/authority changed/i);
        await expect(stat(path.join(moved, "recovery.lock"))).resolves.toBeDefined();
      } finally {
        releaseJournalTest.clearRetainedFilesystemLockReleases();
        await rm(ambient, { recursive: true, force: true });
      }
    },
  );

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
