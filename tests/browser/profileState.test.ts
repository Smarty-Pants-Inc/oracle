import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as profileState from "../../src/browser/profileState.js";
import type { ChromeProcessIdentity } from "../../src/browser/profileState.js";

const PROCESS_NONCE_S = "11111111-1111-4111-8111-111111111111";

function chromeIdentity(
  userDataDir: string,
  overrides: Partial<ChromeProcessIdentity> = {},
): ChromeProcessIdentity {
  const usesWindowsPathRules =
    process.platform === "win32" ||
    /^[a-z]:[\\/]/iu.test(userDataDir) ||
    userDataDir.startsWith("\\\\");
  const pathApi = usesWindowsPathRules ? path.win32 : path;
  const resolvedUserDataDir = pathApi.resolve(userDataDir);
  const existsLocally = existsSync(resolvedUserDataDir);
  const canonicalPath = existsLocally ? realpathSync(resolvedUserDataDir) : resolvedUserDataDir;
  const physical = existsLocally ? statSync(canonicalPath, { bigint: true }) : null;
  const platform = usesWindowsPathRules ? "win32" : process.platform;
  return {
    pid: 4242,
    processStartTime: "process-generation-s",
    executablePath: usesWindowsPathRules
      ? String.raw`c:\program files\google\chrome\application\chrome.exe`
      : "/usr/bin/google-chrome",
    normalizedUserDataDir: platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath,
    launchNonce: PROCESS_NONCE_S,
    profileDirectory: {
      version: 1,
      platform,
      canonicalPath,
      device: physical?.dev.toString() ?? "1",
      inode: physical?.ino.toString() ?? "1",
    },
    ...overrides,
  };
}

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
      expect(existsSync(path.join(dir, "DevToolsActivePort"))).toBe(true);
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
      await profileState.writeChromeProcessIdentity(dir, chromeIdentity(dir, { pid: child.pid }));
      expect(existsSync(path.join(dir, "chrome-process-identity.json"))).toBe(true);
      await expect(profileState.readChromeProcessIdentity(dir)).resolves.toEqual(
        chromeIdentity(dir, { pid: child.pid }),
      );
      await profileState.cleanupStaleProfileState(dir, undefined, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(false);
      }
      expect(existsSync(path.join(dir, "chrome-process-identity.json"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never signals a re-used pid after userspace identity verification", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-terminate-"));
    try {
      const identity = chromeIdentity(dir);
      await profileState.writeChromeProcessIdentity(dir, identity);
      const originalSnapshot = {
        pid: identity.pid,
        processStartTime: identity.processStartTime,
        executablePath: identity.executablePath,
        commandLine: `${identity.executablePath} --user-data-dir="${identity.profileDirectory.canonicalPath}"`,
      };
      await expect(
        profileState.verifyChromeProcessIdentityForTest(dir, identity, {
          readIdentity: async () => identity,
          readProcessSnapshot: async () => originalSnapshot,
          verifyProfileIdentity: async () => true,
        }),
      ).resolves.toBe(true);

      const signalByPid = vi.fn(async () => ({ stdout: "SUCCESS" }));
      await expect(
        profileState.terminateRecordedChromeForProfileForTest(dir, identity, undefined, {
          readIdentity: async () => identity,
          readProcessSnapshot: async () => ({
            ...originalSnapshot,
            processStartTime: "reused-process-generation",
          }),
          verifyProfileIdentity: async () => true,
          isProcessAlive: () => true,
          isChromeUsingUserDataDir: async () => false,
          execute: signalByPid,
        }),
      ).resolves.toMatchObject({
        status: "unsafe",
        pid: identity.pid,
        reason: expect.stringMatching(/no retained stable process handle/i),
      });
      expect(signalByPid).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads and validates a Windows Chrome command line without case-sensitive path assumptions", async () => {
    const profileDir = String.raw`C:\Users\Oracle\AppData\Local\Temp\oracle-browser-session`;
    const command = String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="c:\users\oracle\appdata\local\temp\oracle-browser-session"`;
    expect(profileState.isChromeCommandForUserDataDirForTest(command, profileDir, "win32")).toBe(
      true,
    );
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\Oracle\AppData\Local\Temp\.\oracle-browser-session"`,
        profileDir,
        "win32",
      ),
    ).toBe(true);

    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\Oracle\AppData\Local\Temp\oracle-browser-session-other"`,
        profileDir,
        "win32",
      ),
    ).toBe(false);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `${command} --user-data-dir="${profileDir}-other"`,
        profileDir,
        "win32",
      ),
    ).toBe(false);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "https://example.test/${profileDir}" --user-data-dir="${profileDir}-other"`,
        profileDir,
        "win32",
      ),
    ).toBe(false);
  });

  test("crash recovery without stable authority remains pending and never taskkills", async () => {
    const profileDir = String.raw`C:\Users\Oracle\AppData\Local\Temp\oracle-browser-session`;
    const identity = chromeIdentity(profileDir);
    const terminationCalls: Array<{ file: string; args: string[] }> = [];
    await expect(
      profileState.terminateRecordedChromeForProfileForTest(profileDir, identity, undefined, {
        platform: "win32",
        readIdentity: async () => identity,
        verifyProfileIdentity: async () => true,
        isProcessAlive: () => true,
        isChromeUsingUserDataDir: async () => false,
        execute: async (file, args) => {
          terminationCalls.push({ file, args });
          return { stdout: "SUCCESS" };
        },
      }),
    ).resolves.toMatchObject({
      status: "unsafe",
      pid: identity.pid,
      reason: expect.stringMatching(/authenticated exact Chrome control channel/i),
    });
    expect(terminationCalls).toEqual([]);
  });

  test("rejects descendant symlink traversal before profile authority", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-symlink-"));
    const physical = path.join(root, "physical");
    const alias = path.join(root, "alias");
    try {
      await mkdir(physical);
      await symlink(physical, alias, "dir");
      const nestedProfile = path.join(alias, "new-profile");
      await expect(
        profileState.captureProfileDirectoryIdentity(nestedProfile, { create: true }),
      ).rejects.toThrow(/symlink|reparse/i);
      expect(existsSync(path.join(physical, "new-profile"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rename retargeting cannot redirect destructive cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-retarget-"));
    const profileDir = path.join(root, "profile");
    const movedDir = path.join(root, "moved-profile");
    try {
      await mkdir(profileDir);
      await profileState.writeDevToolsActivePort(profileDir, 12345);
      const identity = await profileState.captureProfileDirectoryIdentity(profileDir);
      await expect(
        profileState.cleanupStaleProfileStateForTest(
          profileDir,
          undefined,
          { lockRemovalMode: "never", expectedProfileIdentity: identity },
          {
            beforeDestructiveCleanup: async () => {
              await rename(profileDir, movedDir);
              await mkdir(profileDir);
              await writeFile(path.join(profileDir, "replacement-marker"), "keep");
            },
          },
        ),
      ).resolves.toBe(false);
      expect(existsSync(path.join(profileDir, "replacement-marker"))).toBe(true);
      expect(existsSync(path.join(movedDir, "DevToolsActivePort"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("profile persistence rejects a renamed and replaced directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-persist-retarget-"));
    const profileDir = path.join(root, "profile");
    const movedDir = path.join(root, "moved-profile");
    try {
      await mkdir(profileDir);
      const identity = chromeIdentity(profileDir);
      await rename(profileDir, movedDir);
      await mkdir(profileDir);
      await expect(profileState.writeChromeProcessIdentity(profileDir, identity)).rejects.toThrow(
        /does not belong|physical profile/i,
      );
      expect(existsSync(path.join(profileDir, "chrome-process-identity.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
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

  test("skips normal manual-login cleanup when reused Chrome is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: false,
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

  test("preserves the lock when the profile directory generation changes before release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-generation-"));
    const dir = path.join(root, "profile");
    const moved = path.join(root, "moved-profile");
    await mkdir(dir);
    try {
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      expect(lock).not.toBeNull();
      await rename(dir, moved);
      await mkdir(dir);

      await expect(lock?.release()).rejects.toThrow(/identity changed/i);
      expect(existsSync(path.join(moved, "oracle-automation.lock"))).toBe(true);
      expect(existsSync(path.join(dir, "oracle-automation.lock"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
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
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          version: 1,
          pid: child.pid,
          processStartIdentity: "dead-process-start",
          ownerNonce: "stale-owner-generation",
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      expect(lock).not.toBeNull();
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for an unreadable legacy profile lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lockPath = path.join(dir, "oracle-automation.lock");
      await writeFile(lockPath, "not-json");
      await expect(
        profileState.acquireProfileRunLock(dir, { timeoutMs: 150, pollMs: 50 }),
      ).rejects.toThrow(/profile lock/i);
      await expect(readFile(lockPath, "utf8")).resolves.toBe("not-json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("matches recorded Chrome commands to the expected profile", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}`,
        dir,
      ),
    ).toBe(true);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}/./`,
        dir,
      ),
    ).toBe(true);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/other",
        dir,
      ),
    ).toBe(false);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}-other`,
        dir,
      ),
    ).toBe(false);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome https://example.test/${dir} --user-data-dir=/tmp/other`,
        dir,
      ),
    ).toBe(false);
    expect(profileState.isChromeCommandForUserDataDirForTest("node worker.js", dir)).toBe(false);
  });

  test("discovers running Chrome DevTools port from process list", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    const processList = `
      123 node worker.js
      456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=64305 --user-data-dir=${dir} about:blank
      789 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/other
    `;

    expect(
      profileState.findChromeDebugTargetForProfileFromProcessListForTest(processList, dir),
    ).toEqual({
      pid: 456,
      port: 64305,
    });
  });
});
