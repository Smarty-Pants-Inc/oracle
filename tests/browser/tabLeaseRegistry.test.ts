import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readProcessStartIdentity } from "../../src/browser/filesystemLock.js";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  normalizeMaxConcurrentTabs,
  teardownBrowserResourcesIfNoActiveLeases,
} from "../../src/browser/tabLeaseRegistry.js";

describe("tabLeaseRegistry", () => {
  test("normalizes the concurrent tab limit", () => {
    expect(normalizeMaxConcurrentTabs(undefined)).toBe(3);
    expect(normalizeMaxConcurrentTabs("4")).toBe(4);
    expect(normalizeMaxConcurrentTabs(0)).toBe(3);
    expect(normalizeMaxConcurrentTabs("nope")).toBe(3);
  });

  test("fails without publishing a lease when process generation is unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      await expect(
        acquireBrowserTabLease(
          dir,
          { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "missing-generation" },
          {
            pid: 123_456,
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

  test("queues when the max concurrent tab limit is reached", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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

  test("drops a live pid lease when its process-start identity changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "reused-pid-session" },
        {
          pid: 345_678,
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async () => "original-process-start",
        },
      );

      const fresh = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "replacement-session" },
        {
          readProcessLiveness: () => "alive",
          readProcessStartIdentity: async (pid) =>
            pid === 345_678 ? "reused-process-start" : "replacement-process-start",
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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

  test("runs teardown only while the registry is empty and locked", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const missingDir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    const malformedDir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
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
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-lease-retarget-"));
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
