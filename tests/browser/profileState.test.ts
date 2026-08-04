import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as profileState from "../../src/browser/profileState.js";
import type { ChromeProcessIdentity } from "../../src/browser/profileState.js";

const PROCESS_NONCE_S = "11111111-1111-4111-8111-111111111111";
const PROCESS_NONCE_T = "22222222-2222-4222-8222-222222222222";

function chromeIdentity(
  normalizedUserDataDir: string,
  overrides: Partial<ChromeProcessIdentity> = {},
): ChromeProcessIdentity {
  return {
    pid: 4242,
    processStartTime: "process-generation-s",
    executablePath: "/usr/bin/google-chrome",
    normalizedUserDataDir,
    launchNonce: PROCESS_NONCE_S,
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

  test("waits for Chrome profile processes before returning from termination", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-terminate-"));
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
          const fs = require("node:fs");
          const path = require("node:path");
          const profile = process.argv[1];
          process.on("SIGTERM", () => process.send?.("sigterm"));
          process.on("message", (message) => {
            if (message !== "exit") return;
            fs.mkdirSync(profile, { recursive: true });
            fs.writeFileSync(path.join(profile, "late-write"), "late");
            process.exit(0);
          });
          process.send?.("ready");
        `,
        dir,
        "chrome",
        `--user-data-dir=${dir}`,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );

    try {
      if (!child.pid) throw new Error("Failed to start Chrome fixture");
      await once(child, "message");
      const identity = chromeIdentity(dir, { pid: child.pid });
      const processSnapshot = {
        pid: child.pid,
        processStartTime: identity.processStartTime,
        executablePath: identity.executablePath,
        commandLine: `/usr/bin/google-chrome --user-data-dir="${dir}"`,
      };

      const signalReceived = once(child, "message").then(([message]) => {
        expect(message).toBe("sigterm");
        return "signal" as const;
      });
      const termination = profileState.terminateRecordedChromeForProfileForTest(
        dir,
        identity,
        undefined,
        {
          platform: process.platform,
          readIdentity: async () => identity,
          readProcessSnapshot: async () => processSnapshot,
        },
      );
      await expect(
        Promise.race([termination.then(() => "terminated" as const), signalReceived]),
      ).resolves.toBe("signal");

      child.send("exit");
      await expect(termination).resolves.toMatchObject({
        status: "stopped",
        pid: child.pid,
        signal: "SIGTERM",
      });
      expect(profileState.isProcessAlive(child.pid)).toBe(false);

      await rm(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);
    } finally {
      child.kill("SIGKILL");
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

    const terminationCalls: Array<{ file: string; args: string[] }> = [];
    const terminate = async (file: string, args: string[]) => {
      terminationCalls.push({ file, args });
      return { stdout: "SUCCESS" };
    };
    await profileState.terminateChromeProcessForTest(4242, false, "win32", terminate);
    await profileState.terminateChromeProcessForTest(4242, true, "win32", terminate);
    expect(terminationCalls).toEqual([
      { file: "taskkill.exe", args: ["/PID", "4242", "/T"] },
      { file: "taskkill.exe", args: ["/PID", "4242", "/T", "/F"] },
    ]);
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

  test("rejects stale Windows cleanup authority and revalidates before forced tree termination", async () => {
    const profileDir = String.raw`C:\Users\Oracle\AppData\Local\Temp\oracle-browser-session`;
    const normalizedProfileDir = profileDir.toLowerCase();
    const executablePath = String.raw`c:\program files\google\chrome\application\chrome.exe`;
    const commandLine = String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\Oracle\AppData\Local\Temp\oracle-browser-session"`;
    const sessionIdentity = chromeIdentity(normalizedProfileDir, {
      executablePath,
      processStartTime: "creation-s",
    });
    const laterIdentity = chromeIdentity(normalizedProfileDir, {
      executablePath,
      processStartTime: "creation-t",
      launchNonce: PROCESS_NONCE_T,
    });
    const laterSnapshot = {
      pid: laterIdentity.pid,
      processStartTime: laterIdentity.processStartTime,
      executablePath,
      commandLine,
    };
    const rejectedCalls: Array<{ file: string; args: string[] }> = [];
    await expect(
      profileState.terminateRecordedChromeForProfileForTest(
        profileDir,
        sessionIdentity,
        undefined,
        {
          platform: "win32",
          readIdentity: async () => laterIdentity,
          readProcessSnapshot: async () => laterSnapshot,
          execute: async (file, args) => {
            rejectedCalls.push({ file, args });
            return { stdout: "SUCCESS" };
          },
          isProcessAlive: () => true,
          isChromeUsingUserDataDir: async () => true,
          waitForChromeProfileProcessesToExit: async () => false,
        },
      ),
    ).resolves.toMatchObject({
      status: "unsafe",
      pid: 4242,
      reason: `Chrome cleanup authority is stale for ${profileDir}`,
    });
    expect(rejectedCalls.some(({ file }) => file === "taskkill.exe")).toBe(false);

    let snapshotRead = 0;
    const sessionSnapshot = {
      pid: sessionIdentity.pid,
      processStartTime: sessionIdentity.processStartTime,
      executablePath,
      commandLine,
    };
    const calls: Array<{ file: string; args: string[] }> = [];
    await expect(
      profileState.terminateRecordedChromeForProfileForTest(
        profileDir,
        sessionIdentity,
        undefined,
        {
          platform: "win32",
          readIdentity: async () => sessionIdentity,
          readProcessSnapshot: async () => {
            const snapshot = snapshotRead === 0 ? sessionSnapshot : laterSnapshot;
            snapshotRead += 1;
            return snapshot;
          },
          execute: async (file, args) => {
            calls.push({ file, args });
            return { stdout: "SUCCESS" };
          },
          isProcessAlive: () => true,
          isChromeUsingUserDataDir: async () => true,
          waitForChromeProfileProcessesToExit: async () => false,
        },
      ),
    ).resolves.toMatchObject({
      status: "unsafe",
      pid: 4242,
      reason: "Chrome pid 4242 changed before forced termination",
    });
    expect(calls.filter(({ file }) => file === "taskkill.exe")).toEqual([
      { file: "taskkill.exe", args: ["/PID", "4242", "/T"] },
    ]);
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
