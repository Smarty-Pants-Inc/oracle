import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as profileState from "../../src/browser/profileState.js";

describe("profileState", () => {
  test("writes DevToolsActivePort to both root and Default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      const root = path.join(dir, "DevToolsActivePort");
      const nested = path.join(dir, "Default", "DevToolsActivePort");
      expect(existsSync(root)).toBe(true);
      expect(existsSync(nested)).toBe(true);
      expect((await readFile(root, "utf8")).split("\n")[0]?.trim()).toBe("12345");
      expect((await readFile(nested, "utf8")).split("\n")[0]?.trim()).toBe("12345");
      await expect(profileState.readDevToolsPort(dir)).resolves.toBe(12345);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleans DevToolsActivePort, but only removes locks when oracle pid is dead", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    const lockFiles = [
      path.join(dir, "lockfile"),
      path.join(dir, "SingletonLock"),
      path.join(dir, "SingletonSocket"),
      path.join(dir, "SingletonCookie"),
    ];
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      for (const lock of lockFiles) {
        await writeFile(lock, "x");
      }

      // Alive pid => keep locks
      await profileState.writeChromePid(dir, process.pid);
      await profileState.cleanupStaleProfileState(dir, undefined, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      expect(existsSync(path.join(dir, "DevToolsActivePort"))).toBe(false);
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(true);
      }

      // Dead pid => remove locks
      for (const lock of lockFiles) {
        await writeFile(lock, "x");
      }
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      await profileState.writeChromePid(dir, child.pid ?? 0);
      await profileState.cleanupStaleProfileState(dir, undefined, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips manual-login cleanup when DevTools port is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: true,
          probe: async () => ({ ok: true }),
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs manual-login cleanup when DevTools port is unreachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: true,
          probe: async () => ({ ok: false, error: "offline" }),
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acquires and releases the manual-login profile lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      expect(lock).not.toBeNull();
      const lockPath = path.join(dir, "oracle-automation.lock");
      expect(existsSync(lockPath)).toBe(true);
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("waits for profile lock and errors on timeout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      await expect(
        profileState.acquireProfileRunLock(dir, { timeoutMs: 150, pollMs: 50 }),
      ).rejects.toThrow(/profile lock/i);
      await lock?.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clears stale profile lock when pid is dead", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      if (!child.pid) {
        throw new Error("Missing child pid");
      }
      const lockPath = path.join(dir, "oracle-automation.lock");
      await writeFile(
        lockPath,
        JSON.stringify({ pid: child.pid, lockId: "stale", createdAt: new Date().toISOString() }),
      );
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      expect(lock).not.toBeNull();
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clears stale profile lock when the pid was reused with a different start marker", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lockPath = path.join(dir, "oracle-automation.lock");
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          lockId: "stale-reused-pid-lock",
          createdAt: new Date().toISOString(),
          processStartMarker: "old-process-start",
        }),
      );
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      const written = JSON.parse(await readFile(lockPath, "utf8")) as { lockId?: string };
      expect(lock).not.toBeNull();
      expect(written.lockId).not.toBe("stale-reused-pid-lock");
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deletes unreadable profile lock and continues", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lockPath = path.join(dir, "oracle-automation.lock");
      await writeFile(lockPath, "not-json");
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 2000, pollMs: 50 });
      expect(lock).not.toBeNull();
      expect(existsSync(lockPath)).toBe(true);
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to SingletonLock when chrome.pid is stale", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    const stale = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await once(stale, "exit");
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      if (!stale.pid || !live.pid) {
        throw new Error("Missing child pid");
      }
      await profileState.writeChromePid(dir, stale.pid);
      await symlink(`Mac-${live.pid}`, path.join(dir, "SingletonLock"));
      await expect(profileState.readChromePid(dir)).resolves.toBe(live.pid);
    } finally {
      live.kill("SIGTERM");
      await once(live, "exit").catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops a stale cached chrome pid when it does not own the profile", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      if (!stale.pid) {
        throw new Error("Missing child pid");
      }
      await profileState.writeChromePid(dir, stale.pid);
      await expect(profileState.resolveChromePidForUserDataDir(dir, stale.pid)).resolves.toBeNull();
    } finally {
      stale.kill("SIGTERM");
      await once(stale, "exit").catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "requires an exact --user-data-dir match for chrome ownership checks",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
      const otherDir = `${dir}-copy`;
      const binDir = await mkdtemp(path.join(os.tmpdir(), "oracle-fake-chrome-"));
      const chromePath = path.join(binDir, "chrome");
      await writeFile(chromePath, "#!/bin/sh\nsleep 30\n", "utf8");
      await chmod(chromePath, 0o755);
      const fakeChrome = spawn(chromePath, [`--user-data-dir=${dir}`], { stdio: "ignore" });
      try {
        if (!fakeChrome.pid) {
          throw new Error("Missing fake chrome pid");
        }
        await expect(profileState.chromePidMatchesUserDataDir(fakeChrome.pid, dir)).resolves.toBe(
          true,
        );
        await expect(
          profileState.chromePidMatchesUserDataDir(fakeChrome.pid, otherDir),
        ).resolves.toBe(false);
      } finally {
        fakeChrome.kill("SIGTERM");
        await once(fakeChrome, "exit").catch(() => undefined);
        await rm(binDir, { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
