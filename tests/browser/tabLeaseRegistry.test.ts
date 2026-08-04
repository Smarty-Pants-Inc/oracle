import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("queues when the max concurrent tab limit is reached", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const logger = vi.fn();
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

      await new Promise((resolve) => setTimeout(resolve, 75));
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
        { pid: 123_456, isProcessAlive: () => true },
      );
      await stale.update({ chromeTargetId: "target-stale" });

      const fresh = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "fresh-session" },
        { isProcessAlive: (pid) => pid !== 123_456 },
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

  test("blocks a new lease until final-lease cleanup completes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const current = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      let finishCleanup!: () => void;
      const cleanupStarted = new Promise<void>((resolveStarted) => {
        void current.release({
          onRelease: async ({ isLastLease }) => {
            expect(isLastLease).toBe(true);
            resolveStarted();
            await new Promise<void>((resolveCleanup) => {
              finishCleanup = resolveCleanup;
            });
          },
        });
      });
      await cleanupStarted;

      let acquired = false;
      const nextPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 1000,
      }).then((lease) => {
        acquired = true;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(acquired).toBe(false);

      finishCleanup();
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
});
