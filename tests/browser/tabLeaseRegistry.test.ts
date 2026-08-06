import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
  readProcessStartIdentity,
} from "../../src/browser/filesystemLock.js";
import { isSafeChromeTerminationOutcome } from "../../src/browser/profileState.js";
import { createStableChildProcessChromeKill } from "../../src/browser/chromeLifecycle.js";
import type * as FilesystemLockModule from "../../src/browser/filesystemLock.js";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  normalizeMaxConcurrentTabs,
  retainBrowserTabLeaseTeardownAuthority,
  teardownBrowserResourcesIfNoActiveLeases,
} from "../../src/browser/tabLeaseRegistry.js";
import {
  BrowserRunLifecycleController,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
} from "../../src/browser/runLifecycle.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";

const CANONICAL_TEMP_ROOT = await realpath(os.tmpdir());

function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(CANONICAL_TEMP_ROOT, prefix));
}

describe("tabLeaseRegistry", { timeout: 15_000 }, () => {
  test("normalizes the concurrent tab limit", () => {
    expect(normalizeMaxConcurrentTabs(undefined)).toBe(3);
    expect(normalizeMaxConcurrentTabs("4")).toBe(4);
    expect(normalizeMaxConcurrentTabs(0)).toBe(3);
    expect(normalizeMaxConcurrentTabs("nope")).toBe(3);
  });

  test("rejects an injected null process generation without publishing a lease", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      await expect(
        acquireBrowserTabLease(
          dir,
          { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "missing-generation" },
          {
            pid: process.pid,
            platform: "win32",
            readProcessStartIdentity: async () => null,
          },
        ),
      ).rejects.toThrow(/without a stable process generation/i);
      await expect(
        readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("permits a default current-Windows lease when both lease and lock generations are null", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const leaseReadIdentity = vi.fn(async (_pid: number, _timeoutMs?: number) => null);
    const lockReadIdentity = vi.fn(async (_pid: number, _timeoutMs?: number) => null);
    try {
      // This test must reload the registry module so its static lock imports bind to the mocks.
      vi.resetModules();
      vi.doMock("../../src/browser/filesystemLock.js", async (importOriginal) => {
        const actual = await importOriginal<typeof FilesystemLockModule>();
        const acquireWithUnavailableCurrentIdentity: typeof actual.acquireCrashRecoverableFilesystemLock =
          (lockPath, options, deps) =>
            actual.acquireCrashRecoverableFilesystemLock(lockPath, options, {
              ...deps,
              processIdentityProvider: {
                platform: "win32",
                pid: process.pid,
                readProcessLiveness: () => "alive",
                readProcessStartIdentity: lockReadIdentity,
              },
            });
        return {
          ...actual,
          acquireCrashRecoverableFilesystemLock: acquireWithUnavailableCurrentIdentity,
          readProcessStartIdentity: leaseReadIdentity,
        };
      });
      const { acquireBrowserTabLease: acquireWindowsBrowserTabLease } =
        await import("../../src/browser/tabLeaseRegistry.js");

      const lease = await acquireWindowsBrowserTabLease(
        dir,
        { timeoutMs: 500 },
        { platform: "win32" },
      );
      await lease.update({ chromeTargetId: "current-windows-null-generation" });
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ id: string; processStartIdentity: string | null }> };
      expect(leaseReadIdentity).toHaveBeenCalledWith(process.pid);
      expect(lockReadIdentity).toHaveBeenCalled();
      expect(lockReadIdentity.mock.calls.every(([pid]) => pid === process.pid)).toBe(true);
      expect(registry.leases).toEqual([
        expect.objectContaining({ id: lease.id, processStartIdentity: null }),
      ]);
      await lease.release();
    } finally {
      vi.doUnmock("../../src/browser/filesystemLock.js");
      vi.resetModules();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a live unknown-generation Windows registry lock busy and reclaims it only after death", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const lockPath = path.join(dir, "oracle-tab-leases.lock");
    const contenderPid = process.pid + 100_000;
    let ownerAlive = true;
    const contenderIdentity = vi.fn(async (pid: number) =>
      pid === contenderPid ? "win32:contender-generation" : "win32:replacement-generation",
    );
    const acquireContender = () =>
      acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: {
            platform: "win32",
            pid: contenderPid,
            readProcessLiveness: (pid) => (pid === process.pid && !ownerAlive ? "dead" : "alive"),
            readProcessStartIdentity: contenderIdentity,
          },
        },
      );
    try {
      const unavailableIdentity = async () => null;
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: {
              platform: "win32",
              pid: process.pid,
              readProcessLiveness: () => "alive",
              readProcessStartIdentity: unavailableIdentity,
            },
          },
        ),
      ).rejects.toThrow(/without a stable process generation/i);
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          { processGenerationPolicy: "allow-unstable-current-win32" },
          {
            processIdentityProvider: {
              platform: "win32",
              pid: contenderPid,
              readProcessLiveness: () => "alive",
              readProcessStartIdentity: unavailableIdentity,
            },
          },
        ),
      ).rejects.toThrow(/without a stable process generation/i);
      const owner = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        { processGenerationPolicy: "allow-unstable-current-win32" },
        {
          processIdentityProvider: {
            platform: "win32",
            pid: process.pid,
            readProcessLiveness: () => "alive",
            readProcessStartIdentity: async () => null,
          },
        },
      );
      expect(owner.owner.processStartIdentity).toBeNull();

      await expect(acquireContender()).rejects.toBeInstanceOf(FilesystemLockBusyError);
      expect(contenderIdentity.mock.calls.every(([pid]) => pid === contenderPid)).toBe(true);

      ownerAlive = false;
      const replacement = await acquireContender();
      expect(replacement.owner).toMatchObject({
        pid: contenderPid,
        processStartIdentity: "win32:contender-generation",
      });
      await replacement.release();
      await owner.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prunes a dead exact-base v1 lease and atomically rewrites the registry", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const registryPath = path.join(dir, "oracle-tab-leases.json");
    const legacyLease = {
      id: "base-v1-dead-lease",
      pid: 76_543,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeFile(registryPath, JSON.stringify({ version: 1, leases: [legacyLease] }), "utf8");

      await expect(
        hasOtherActiveBrowserTabLeases(dir, "other-lease", {
          readProcessLiveness: () => "dead",
        }),
      ).resolves.toBe(false);

      await expect(readFile(registryPath, "utf8")).resolves.toMatch(/"version": 2/);
      await expect(readFile(registryPath, "utf8")).resolves.toMatch(/"leases": \[\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves live and unknown exact-base leases as authoritative after migration", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const registryPath = path.join(dir, "oracle-tab-leases.json");
    const legacyLease = {
      id: "base-v1-live-lease",
      pid: 76_544,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeFile(registryPath, JSON.stringify({ version: 1, leases: [legacyLease] }), "utf8");

      await expect(
        acquireBrowserTabLease(
          dir,
          { maxConcurrentTabs: 1, timeoutMs: 100, pollMs: 25 },
          {
            pid: 76_545,
            readProcessLiveness: () => "alive",
            readProcessStartIdentity: async () => "new-process-generation",
          },
        ),
      ).rejects.toThrow(/timed out waiting/i);
      const migrated = JSON.parse(await readFile(registryPath, "utf8")) as {
        version: number;
        leases: Array<Record<string, unknown>>;
      };
      expect(migrated).toMatchObject({
        version: 2,
        leases: [expect.objectContaining(legacyLease)],
      });
      expect(migrated.leases[0]).not.toHaveProperty("processStartIdentity");

      const teardown = vi.fn(async () => true);
      await expect(
        teardownBrowserResourcesIfNoActiveLeases(dir, teardown, {
          readProcessLiveness: () => "unknown",
        }),
      ).resolves.toEqual({ status: "preserved", reason: "active-leases" });
      expect(teardown).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("migrates a v1 current-generation lease through its release path", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const registryPath = path.join(dir, "oracle-tab-leases.json");
    try {
      const lease = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
      const current = JSON.parse(await readFile(registryPath, "utf8")) as { leases: unknown[] };
      await writeFile(registryPath, JSON.stringify({ version: 1, leases: current.leases }), "utf8");

      await lease.release();

      await expect(readFile(registryPath, "utf8")).resolves.toMatch(/"version": 2/);
      await expect(readFile(registryPath, "utf8")).resolves.toMatch(/"leases": \[\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains a live null-generation lease and prunes it only after its pid is dead", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const registryPath = path.join(dir, "oracle-tab-leases.json");
    const nullGenerationLease = {
      id: "null-generation-owner",
      pid: 76_543,
      processStartIdentity: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeFile(
        registryPath,
        JSON.stringify({ version: 1, leases: [nullGenerationLease] }),
        "utf8",
      );

      await expect(
        hasOtherActiveBrowserTabLeases(dir, "other-lease", {
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "replacement-generation",
        }),
      ).resolves.toBe(true);
      expect(JSON.parse(await readFile(registryPath, "utf8"))).toMatchObject({
        version: 2,
        leases: [{ processStartIdentity: null }],
      });

      await expect(
        hasOtherActiveBrowserTabLeases(dir, "other-lease", {
          readProcessLiveness: () => "unknown",
          readProcessStartIdentity: async () => "replacement-generation",
        }),
      ).resolves.toBe(true);
      expect(JSON.parse(await readFile(registryPath, "utf8"))).toMatchObject({
        version: 2,
        leases: [{ processStartIdentity: null }],
      });
      await expect(
        hasOtherActiveBrowserTabLeases(dir, "other-lease", {
          readProcessLiveness: () => "dead",
          readProcessStartIdentity: async () => "replacement-generation",
        }),
      ).resolves.toBe(false);
      await expect(readFile(registryPath, "utf8")).resolves.toContain('"leases": []');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("queues when the max concurrent tab limit is reached", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      let signalWaiting: () => void = () => undefined;
      const waitingForSlot = new Promise<void>((resolve) => {
        signalWaiting = resolve;
      });
      const logger = vi.fn((message: string) => {
        if (message.includes("Waiting for ChatGPT browser slot")) signalWaiting();
      });
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      const third = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      let resolved = false;
      const fourthPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 1000,
        logger,
      }).then((lease) => {
        resolved = true;
        return lease;
      });

      await Promise.race([
        waitingForSlot,
        fourthPromise.then(() => {
          throw new Error("Queued browser lease acquired before emitting its waiting signal");
        }),
      ]);
      expect(resolved).toBe(false);
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("Waiting for ChatGPT browser slot"),
      );

      await first.release();
      const fourth = await fourthPromise;
      expect(resolved).toBe(true);

      await second.release();
      await third.release();
      await fourth.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops stale leases owned by dead pids", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      const stale = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "stale-session" },
        {
          pid: 123_456,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "stale-process-start",
        },
      );
      await stale.update({ chromeTargetId: "target-stale" });

      const fresh = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "fresh-session" },
        {
          readProcessLiveness: (pid) => (pid === 123_456 ? "dead" : "alive"),
          readProcessStartIdentity: async () => "fresh-process-start",
        },
      );
      await fresh.update({ chromeTargetId: "target-fresh", tabUrl: "https://chatgpt.com/c/1" });

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ sessionId?: string; chromeTargetId?: string; tabUrl?: string }> };
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0]).toMatchObject({
        sessionId: "fresh-session",
        chromeTargetId: "target-fresh",
        tabUrl: "https://chatgpt.com/c/1",
      });

      await fresh.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves a live Darwin lease across process-generation provider changes", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "darwin-provider-fallback" },
        {
          pid: 345_678,
          platform: "darwin",
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "darwin-sample-launch:2026-08-05T11:57:07.287-0400",
        },
      );

      for (const observedIdentity of [
        "darwin-kernel-start:1785945427:287123",
        "darwin-audit-pidversion:7001",
      ]) {
        await expect(
          hasOtherActiveBrowserTabLeases(dir, "unrelated-lease", {
            readProcessLiveness: () => "alive",
            readProcessStartIdentity: async () => observedIdentity,
          }),
        ).resolves.toBe(true);
      }
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ sessionId?: string }> };
      expect(registry.leases).toEqual([
        expect.objectContaining({ sessionId: "darwin-provider-fallback" }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops a live Darwin PID lease when its provider proves a generation mismatch", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "reused-pid-session" },
        {
          pid: 345_678,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "darwin-kernel-start:1785945427:287123",
        },
      );

      const fresh = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "replacement-session" },
        {
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) =>
            pid === 345_678
              ? "darwin-kernel-start:1785945427:287124"
              : "darwin-kernel-start:1785945427:999999",
        },
      );

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ sessionId?: string }> };
      expect(registry.leases).toEqual([
        expect.objectContaining({ sessionId: "replacement-session" }),
      ]);
      await fresh.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains a live matching lease after more than six hours", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
    try {
      await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "long-running-session" },
        {
          now: () => sevenHoursAgo,
          pid: 234_567,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "long-running-process-start",
        },
      );

      const teardown = vi.fn(async () => true);
      await expect(
        teardownBrowserResourcesIfNoActiveLeases(dir, teardown, {
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "long-running-process-start",
        }),
      ).resolves.toEqual({ status: "preserved", reason: "active-leases" });
      expect(teardown).not.toHaveBeenCalled();

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ sessionId?: string; processStartIdentity: string }> };
      expect(registry.leases).toEqual([
        expect.objectContaining({
          sessionId: "long-running-session",
          processStartIdentity: "long-running-process-start",
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects other active leases before releasing a shared Chrome owner", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "first-session",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "second-session",
      });

      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(true);

      await second.release();
      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(false);

      await first.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs cleanup exactly once when concurrent runs release their final lease", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      const firstCleanup = vi.fn(async () => undefined);
      const secondCleanup = vi.fn(async () => undefined);

      await Promise.all([
        first.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) await firstCleanup();
          },
        }),
        second.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) await secondCleanup();
          },
        }),
      ]);

      expect(firstCleanup.mock.calls.length + secondCleanup.mock.calls.length).toBe(1);
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: unknown[] };
      expect(registry.leases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not repeat final-lease cleanup when the same lease is released twice", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      const lease = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
      const cleanup = vi.fn(async () => undefined);

      await lease.release({
        onRelease: async ({ isLastLease }) => {
          if (isLastLease) await cleanup();
        },
      });
      await lease.release({
        onRelease: async ({ isLastLease }) => {
          if (isLastLease) await cleanup();
        },
      });

      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks a new lease until final-lease cleanup completes", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      const current = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      let markCleanupStarted!: () => void;
      const cleanupStarted = new Promise<void>((resolve) => {
        markCleanupStarted = resolve;
      });
      let finishCleanup!: () => void;
      const cleanupFinished = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      const releasePromise = current.release({
        onRelease: async ({ isLastLease }) => {
          expect(isLastLease).toBe(true);
          markCleanupStarted();
          await cleanupFinished;
        },
      });
      await cleanupStarted;

      let acquired = false;
      let markNextAttempted!: () => void;
      const nextAttempted = new Promise<void>((resolve) => {
        markNextAttempted = resolve;
      });
      const nextPromise = acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 3,
          pollMs: 25,
          timeoutMs: 1000,
        },
        {
          readProcessStartIdentity: async (pid) => {
            markNextAttempted();
            return readProcessStartIdentity(pid);
          },
        },
      ).then((lease) => {
        acquired = true;
        return lease;
      });
      await nextAttempted;
      expect(acquired).toBe(false);

      finishCleanup();
      await releasePromise;
      const next = await nextPromise;
      expect(acquired).toBe(true);
      await next.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each(["finalize", "abort"] as const)(
    "retries failed last-lease teardown in the same %s settlement",
    async (mode) => {
      const dir = await makeTempDir("oracle-tab-lease-teardown-retry-");
      try {
        const lease = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
        const teardownAuthority = retainBrowserTabLeaseTeardownAuthority(dir, lease);
        let teardownAttempts = 0;
        const runtime = {
          userDataDir: dir,
          recoveryCleanupResources: [
            {
              userDataDir: dir,
              profileDirectoryIdentity: lease.profileDirectory,
              tabLease: { id: lease.id, profileDirectory: lease.profileDirectory },
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "manual-login" as const,
                keepBrowser: false,
              },
            },
          ],
        };
        const lifecycle = new BrowserRunLifecycleController({
          getRuntime: () => runtime,
          settleResources: async (_settlementMode, pendingRuntime) => {
            const outcome = await teardownAuthority.settle(async () => {
              teardownAttempts += 1;
              return teardownAttempts > 1;
            });
            return outcome.status === "completed"
              ? completedBrowserCaptureCleanup(pendingRuntime)
              : pendingBrowserCaptureCleanup(
                  pendingRuntime,
                  outcome.error ?? `Manual-login cleanup preserved resources (${outcome.reason})`,
                );
          },
        });
        lifecycle.markAcquired();
        const identity = await lifecycle.beginPromptDispatch("retry teardown", 0, 0, 0);
        await lifecycle.recordPromptCommitVerification(
          {
            committedTurns: 1,
            promptSha256: promptIdentitySha256("retry teardown"),
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId: "turn-0",
            verifiedUserMessageId: "message-0",
            conversationId: "cleanup-retry",
          },
          identity,
        );
        const transaction = lifecycle.issueCapture({
          answerText: "captured",
          answerMarkdown: "captured",
          tookMs: 1,
          answerTokens: 1,
          answerChars: 8,
        });

        const first = await transaction[mode]();
        expect(first).toMatchObject({
          status: "pending",
          runtime: {
            recoveryCleanupResult: { status: "failed", settlementMode: mode },
          },
        });
        expect(teardownAuthority.leaseReleased).toBe(true);
        expect(
          JSON.parse(await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8")),
        ).toMatchObject({ leases: [] });

        const second = await transaction[mode]();
        const cached = await transaction[mode]();
        expect(second).toMatchObject({ status: "completed" });
        expect(cached).toBe(second);
        expect(teardownAttempts).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  test("retries active-lease handoff cleanup before completing authority transfer", async () => {
    const dir = await makeTempDir("oracle-tab-lease-handoff-retry-");
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "handoff-first",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "handoff-second",
      });
      const handoff = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient endpoint release failure"))
        .mockResolvedValueOnce(undefined);
      const teardown = vi.fn(async () => true);
      const authority = retainBrowserTabLeaseTeardownAuthority(dir, first, {
        onActiveLeaseHandoff: handoff,
      });

      await expect(authority.settle(teardown)).resolves.toEqual({
        status: "preserved",
        reason: "teardown-unsafe",
        error: "transient endpoint release failure",
      });
      expect(authority.leaseReleased).toBe(true);
      expect(
        JSON.parse(await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8")),
      ).toMatchObject({ leases: [expect.objectContaining({ id: second.id })] });

      await expect(authority.settle(teardown)).resolves.toEqual({
        status: "completed",
        disposition: "active-lease-handoff",
      });
      await expect(authority.settle(teardown)).resolves.toEqual({
        status: "completed",
        disposition: "active-lease-handoff",
      });
      expect(handoff).toHaveBeenCalledTimes(2);
      expect(teardown).not.toHaveBeenCalled();
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reclaims last-lease teardown when a failed handoff target disappears before retry", async () => {
    const dir = await makeTempDir("oracle-tab-lease-handoff-vanished-");
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
      });
      const handoff = vi.fn(async () => {
        throw new Error("transient endpoint release failure");
      });
      const teardown = vi.fn(async () => true);
      const authority = retainBrowserTabLeaseTeardownAuthority(dir, first, {
        onActiveLeaseHandoff: handoff,
      });

      await expect(authority.settle(teardown)).resolves.toMatchObject({
        status: "preserved",
        reason: "teardown-unsafe",
      });
      await second.release();
      await expect(authority.settle(teardown)).resolves.toEqual({
        status: "completed",
        disposition: "teardown-completed",
      });
      expect(handoff).toHaveBeenCalledOnce();
      expect(teardown).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps profile cleanup lease-gated until exact Chrome generation exit is proven", async () => {
    const dir = await makeTempDir("oracle-tab-lease-exact-exit-");
    try {
      const lease = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
      const teardownAuthority = retainBrowserTabLeaseTeardownAuthority(dir, lease);
      const exactControlKill = vi
        .fn()
        .mockResolvedValueOnce({
          status: "unsafe" as const,
          pid: 7890,
          reason: "exact Chrome generation remained alive",
        })
        .mockResolvedValueOnce({
          status: "stopped" as const,
          pid: 7890,
          signal: "CONTROL_CHANNEL" as const,
        });
      const kill = createStableChildProcessChromeKill(
        {
          pid: 7890,
          exitCode: null,
          signalCode: null,
        },
        exactControlKill,
      );
      const cleanupProfile = vi.fn(async () => undefined);
      const teardown = async () => {
        const termination = await kill();
        if (!isSafeChromeTerminationOutcome(termination)) return false;
        await cleanupProfile();
        return true;
      };

      await expect(teardownAuthority.settle(teardown)).resolves.toEqual({
        status: "preserved",
        reason: "teardown-unsafe",
      });
      expect(teardownAuthority.leaseReleased).toBe(true);
      expect(cleanupProfile).not.toHaveBeenCalled();
      expect(exactControlKill).toHaveBeenCalledOnce();
      expect(
        JSON.parse(await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8")),
      ).toMatchObject({ leases: [] });

      await expect(teardownAuthority.settle(teardown)).resolves.toEqual({
        status: "completed",
        disposition: "teardown-completed",
      });
      await expect(teardownAuthority.settle(teardown)).resolves.toEqual({
        status: "completed",
        disposition: "teardown-completed",
      });
      expect(cleanupProfile).toHaveBeenCalledOnce();
      expect(exactControlKill).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains failed teardown authority when another lease appears before retry", async () => {
    const dir = await makeTempDir("oracle-tab-lease-teardown-race-");
    try {
      const first = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
      const teardownAuthority = retainBrowserTabLeaseTeardownAuthority(dir, first);
      let teardownAttempts = 0;
      await expect(
        teardownAuthority.settle(async () => {
          teardownAttempts += 1;
          return false;
        }),
      ).resolves.toMatchObject({ status: "preserved", reason: "teardown-unsafe" });

      const second = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
      await expect(
        teardownAuthority.settle(async () => {
          teardownAttempts += 1;
          return true;
        }),
      ).resolves.toEqual({ status: "preserved", reason: "active-leases" });
      expect(teardownAttempts).toBe(1);

      await second.release();
      await expect(
        teardownAuthority.settle(async () => {
          teardownAttempts += 1;
          return true;
        }),
      ).resolves.toEqual({ status: "completed", disposition: "teardown-completed" });
      await expect(
        teardownAuthority.settle(async () => {
          teardownAttempts += 1;
          return true;
        }),
      ).resolves.toEqual({ status: "completed", disposition: "teardown-completed" });
      expect(teardownAttempts).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs teardown only while the registry is empty and locked", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      const seed = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
      await seed.release();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let finishTeardown!: () => void;
      const finish = new Promise<void>((resolve) => {
        finishTeardown = resolve;
      });
      const teardownPromise = teardownBrowserResourcesIfNoActiveLeases(dir, async () => {
        markStarted();
        await finish;
        return true;
      });
      await started;

      let acquired = false;
      const leasePromise = acquireBrowserTabLease(dir, {
        timeoutMs: 1000,
        pollMs: 25,
      }).then((lease) => {
        acquired = true;
        return lease;
      });
      expect(acquired).toBe(false);
      finishTeardown();
      await expect(teardownPromise).resolves.toEqual({ status: "completed" });
      const lease = await leasePromise;
      expect(acquired).toBe(true);
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves resources when another lease is active", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    try {
      const lease = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
      const teardown = vi.fn(async () => true);
      await expect(teardownBrowserResourcesIfNoActiveLeases(dir, teardown)).resolves.toEqual({
        status: "preserved",
        reason: "active-leases",
      });
      expect(teardown).not.toHaveBeenCalled();
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not treat a torn registry as zero leases during acquire", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const registryPath = path.join(dir, "oracle-tab-leases.json");
    const tornRegistry = '{"version":1,"leases":[';
    try {
      await writeFile(registryPath, tornRegistry, "utf8");

      await expect(
        acquireBrowserTabLease(dir, { maxConcurrentTabs: 1, timeoutMs: 100 }),
      ).rejects.toThrow();
      await expect(readFile(registryPath, "utf8")).resolves.toBe(tornRegistry);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps update and release fail-closed after registry corruption", async () => {
    const dir = await makeTempDir("oracle-tab-leases-");
    const registryPath = path.join(dir, "oracle-tab-leases.json");
    const tornRegistry = '{"version":1,"leases":[{"id":';
    try {
      const lease = await acquireBrowserTabLease(dir, { timeoutMs: 500 });
      await writeFile(registryPath, tornRegistry, "utf8");

      await expect(lease.update({ chromeTargetId: "must-not-write" })).rejects.toThrow();
      await expect(lease.release()).rejects.toThrow();
      await expect(readFile(registryPath, "utf8")).resolves.toBe(tornRegistry);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for missing or malformed registry state", async () => {
    const missingDir = await makeTempDir("oracle-tab-leases-");
    const malformedDir = await makeTempDir("oracle-tab-leases-");
    try {
      const teardown = vi.fn(async () => true);
      await expect(
        teardownBrowserResourcesIfNoActiveLeases(missingDir, teardown),
      ).resolves.toMatchObject({ status: "preserved", reason: "registry-unavailable" });
      await writeFile(path.join(malformedDir, "oracle-tab-leases.json"), "not-json", "utf8");
      await expect(
        teardownBrowserResourcesIfNoActiveLeases(malformedDir, teardown),
      ).resolves.toMatchObject({ status: "preserved", reason: "registry-unavailable" });
      expect(teardown).not.toHaveBeenCalled();
    } finally {
      await rm(missingDir, { recursive: true, force: true });
      await rm(malformedDir, { recursive: true, force: true });
    }
  });

  test("never updates or releases a lease through a retargeted profile path", async () => {
    const root = await makeTempDir("oracle-tab-lease-retarget-");
    const profileDir = path.join(root, "profile");
    const movedProfileDir = path.join(root, "moved-profile");
    await mkdir(profileDir);
    try {
      const lease = await acquireBrowserTabLease(profileDir, {
        timeoutMs: 500,
        sessionId: "physical-profile-generation",
      });
      await rename(profileDir, movedProfileDir);
      await mkdir(profileDir);
      await writeFile(path.join(profileDir, "replacement-marker"), "keep", "utf8");
      const onRelease = vi.fn(async () => undefined);

      await expect(lease.update({ chromeTargetId: "must-not-write" })).rejects.toThrow(
        /physical browser profile changed/i,
      );
      await expect(lease.release({ onRelease })).rejects.toThrow(
        /physical browser profile changed/i,
      );
      await expect(
        hasOtherActiveBrowserTabLeases(profileDir, lease.id, {
          expectedProfileIdentity: lease.profileDirectory,
        }),
      ).rejects.toThrow(/physical browser profile changed/i);
      expect(onRelease).not.toHaveBeenCalled();
      await expect(
        readFile(path.join(profileDir, "oracle-tab-leases.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const movedRegistry = JSON.parse(
        await readFile(path.join(movedProfileDir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ id: string; chromeTargetId?: string }> };
      expect(movedRegistry.leases).toHaveLength(1);
      expect(movedRegistry.leases[0]?.id).toBe(lease.id);
      expect(movedRegistry.leases[0]).not.toHaveProperty("chromeTargetId");
      await expect(readFile(path.join(profileDir, "replacement-marker"), "utf8")).resolves.toBe(
        "keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
