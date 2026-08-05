import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as profileState from "../../src/browser/profileState.js";
import type {
  ChromeProcessIdentity,
  OracleChromeOwnerRecord,
} from "../../src/browser/profileState.js";

const PROCESS_NONCE_S = "11111111-1111-4111-8111-111111111111";

function syntheticWindowsChromeIdentity(
  userDataDir: string,
  overrides: Partial<ChromeProcessIdentity> = {},
): ChromeProcessIdentity {
  const canonicalPath = path.win32.resolve(userDataDir);
  return {
    pid: 4242,
    processStartTime: "process-generation-s",
    executablePath: path.win32
      .resolve(String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`)
      .toLowerCase(),
    normalizedUserDataDir: canonicalPath.toLowerCase(),
    launchNonce: PROCESS_NONCE_S,
    profileDirectory: {
      version: 1,
      platform: "win32",
      canonicalPath,
      device: "1",
      inode: "1",
    },
    ...overrides,
  };
}

async function physicalChromeIdentity(
  userDataDir: string,
  overrides: Partial<ChromeProcessIdentity> = {},
): Promise<ChromeProcessIdentity> {
  const profileDirectory = await profileState.captureProfileDirectoryIdentity(userDataDir);
  return {
    pid: 4242,
    processStartTime: "process-generation-s",
    executablePath:
      process.platform === "win32"
        ? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`.toLowerCase()
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome",
    normalizedUserDataDir:
      profileDirectory.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath,
    launchNonce: PROCESS_NONCE_S,
    profileDirectory,
    ...overrides,
  };
}

async function writeNativeDevToolsFixture(userDataDir: string, port: number): Promise<void> {
  await writeFile(
    path.join(userDataDir, "DevToolsActivePort"),
    `${port}\n/devtools/browser/test-browser\n`,
    "utf8",
  );
}

async function writeOracleChromeOwnerFixture(
  userDataDir: string,
  owner: OracleChromeOwnerRecord,
): Promise<void> {
  await writeFile(
    path.join(userDataDir, "oracle-chrome-owner.json"),
    `${JSON.stringify(owner)}\n`,
    "utf8",
  );
}

describe("profileState", () => {
  test("reads Chrome-native DevToolsActivePort without publishing Oracle-owned copies", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const nestedDir = path.join(dir, "Default");
      await mkdir(nestedDir);
      await writeNativeDevToolsFixture(dir, 12345);
      await writeFile(
        path.join(nestedDir, "DevToolsActivePort"),
        "54321\n/devtools/browser/nested\n",
        "utf8",
      );
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
      await writeNativeDevToolsFixture(dir, 12345);
      for (const lock of lockFiles) {
        await writeFile(lock, "x");
      }

      // Alive pid => keep locks and the one atomic owner record.
      const aliveIdentity = await physicalChromeIdentity(dir, { pid: process.pid });
      await writeOracleChromeOwnerFixture(dir, {
        port: 12345,
        processIdentity: aliveIdentity,
        disposition: "preserve",
      });
      await profileState.cleanupStaleProfileStateForTest(
        dir,
        undefined,
        { lockRemovalMode: "if_oracle_pid_dead" },
        { isChromeUsingUserDataDir: async () => false },
      );
      expect(existsSync(path.join(dir, "DevToolsActivePort"))).toBe(true);
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(true);
      }

      // Dead pid => remove locks and the matching owner generation.
      for (const lock of lockFiles) {
        await writeFile(lock, "x");
      }
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      if (!child.pid) throw new Error("Exited child never published a pid");
      const deadIdentity = await physicalChromeIdentity(dir, { pid: child.pid });
      await writeOracleChromeOwnerFixture(dir, {
        port: 12345,
        processIdentity: deadIdentity,
        disposition: "close-on-last-lease",
      });
      expect(existsSync(path.join(dir, "oracle-chrome-owner.json"))).toBe(true);
      await expect(profileState.readOracleChromeOwner(dir)).resolves.toEqual({
        port: 12345,
        processIdentity: deadIdentity,
        disposition: "close-on-last-lease",
      });
      await profileState.cleanupStaleProfileStateForTest(
        dir,
        undefined,
        { lockRemovalMode: "if_oracle_pid_dead" },
        { isChromeUsingUserDataDir: async () => false },
      );
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(false);
      }
      expect(existsSync(path.join(dir, "oracle-chrome-owner.json"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never signals a re-used pid after userspace identity verification", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-terminate-"));
    try {
      const identity = await physicalChromeIdentity(dir);
      await profileState.writeOracleChromeOwner(dir, {
        port: 12345,
        processIdentity: identity,
        disposition: "close-on-last-lease",
      });
      const originalSnapshot = {
        pid: identity.pid,
        processStartTime: identity.processStartTime,
        executablePath: identity.executablePath,
        commandLine: `${identity.executablePath} --user-data-dir="${identity.profileDirectory.canonicalPath}"`,
      };
      await expect(
        profileState.verifyChromeProcessIdentityForTest(dir, identity, {
          readOwner: async () => ({
            port: 12345,
            processIdentity: identity,
            disposition: "close-on-last-lease",
          }),
          readProcessSnapshot: async () => originalSnapshot,
          verifyProfileIdentity: async () => true,
          isProcessAlive: () => true,
        }),
      ).resolves.toBe(true);

      const signalByPid = vi.fn(async () => ({ stdout: "SUCCESS" }));
      await expect(
        profileState.terminateRecordedChromeForProfileForTest(dir, identity, undefined, {
          readOwner: async () => ({
            port: 12345,
            processIdentity: identity,
            disposition: "close-on-last-lease",
          }),
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

  test("captures a macOS Chrome generation from its audit token and physical text vnode", async () => {
    const userDataDir = "/tmp/oracle-mac-profile";
    const launchClaim = {
      version: 1 as const,
      generationId: "40000000-0000-4000-8000-000000000004",
      nonce: "50000000-0000-4000-8000-000000000005",
    };
    const profileDirectory = {
      version: 1 as const,
      platform: "darwin" as const,
      canonicalPath: userDataDir,
      device: "1",
      inode: "2",
    };
    const execute = vi.fn(async (file: string, args: string[]) => {
      if (file === "/usr/bin/lsappinfo") {
        return {
          stdout:
            '"Google Chrome" ASN:0x0-0x1234: pid = 4321 token=[sess=100020 pid=4321 uid:501,501,501 g:20,20 pV:7001]\n',
        };
      }
      if (file === "/usr/sbin/lsof") {
        return {
          stdout: "p4321\nftxt\nn/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n",
        };
      }
      if (file === "ps" && args.at(-1) === "command=") {
        return {
          stdout: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${userDataDir} --oracle-launch-claim=${launchClaim.generationId}:${launchClaim.nonce}\n`,
        };
      }
      throw new Error(`Unexpected process query: ${file} ${args.join(" ")}`);
    });

    await expect(
      profileState.captureChromeProcessIdentityForTest(userDataDir, 4321, {
        platform: "darwin",
        execute,
        captureProfileIdentity: async () => profileDirectory,
        launchClaim,
      }),
    ).resolves.toMatchObject({
      pid: 4321,
      processStartTime: "darwin-audit-pidversion:7001",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      normalizedUserDataDir: userDataDir,
      launchNonce: launchClaim.nonce,
      launchClaim,
    });
    expect(execute).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      expect.arrayContaining(["-p", "4321", "-d", "txt"]),
    );
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenNthCalledWith(1, "/usr/bin/lsappinfo", ["info", "4321"]);
    expect(execute).toHaveBeenNthCalledWith(4, "/usr/bin/lsappinfo", ["info", "4321"]);
  });

  test("rejects a same-pid same-second macOS replacement while accepting the exact audit generation", async () => {
    const userDataDir = "/tmp/oracle-mac-generation";
    const profileDirectory = {
      version: 1 as const,
      platform: "darwin" as const,
      canonicalPath: userDataDir,
      device: "1",
      inode: "2",
    };
    const identity = {
      pid: 4321,
      processStartTime: "darwin-audit-pidversion:7001",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      normalizedUserDataDir: userDataDir,
      launchNonce: "00000000-0000-4000-8000-000000007001",
      profileDirectory,
    };
    const processExecutor = (pidVersion: number) =>
      vi.fn(async (file: string, args: string[]) => {
        if (file === "/usr/bin/lsappinfo") {
          return {
            stdout: `"Google Chrome" ASN:0x0-0x1234: pid = 4321 token=[sess=100020 pid=4321 uid:501,501,501 g:20,20 pV:${pidVersion}]\n`,
          };
        }
        if (file === "/usr/sbin/lsof") {
          return {
            stdout: "p4321\nftxt\nn/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n",
          };
        }
        if (file === "ps" && args.at(-1) === "command=") {
          return {
            stdout: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${userDataDir}\n`,
          };
        }
        throw new Error(`Unexpected process query: ${file} ${args.join(" ")}`);
      });
    const verifyWith = (execute: (file: string, args: string[]) => Promise<{ stdout: string }>) =>
      profileState.verifyChromeProcessIdentityForTest(userDataDir, identity, {
        platform: "darwin",
        execute,
        readOwner: async () => ({
          port: 45_678,
          processIdentity: identity,
          disposition: "close-on-last-lease",
        }),
        verifyProfileIdentity: async () => true,
        isProcessAlive: () => true,
      });

    const exactGeneration = processExecutor(7001);
    await expect(verifyWith(exactGeneration)).resolves.toBe(true);

    const samePidReplacement = processExecutor(7002);
    await expect(verifyWith(samePidReplacement)).resolves.toBe(false);
    expect(
      samePidReplacement.mock.calls.some(
        ([file, args]) => file === "ps" && args.at(-1) === "lstart=",
      ),
    ).toBe(false);
  });

  test("keeps Darwin inspection current across providers while still verifying process authority", async () => {
    const userDataDir = "/tmp/oracle-mac-provider-generation";
    const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const launchClaim = {
      version: 1 as const,
      generationId: "00000000-0000-4000-8000-000000007001",
      nonce: "00000000-0000-4000-8000-000000007002",
    };
    const identity = {
      pid: 4321,
      processStartTime: "darwin-sample-launch:2026-08-05T11:57:07.287-0400",
      executablePath,
      normalizedUserDataDir: userDataDir,
      launchNonce: launchClaim.nonce,
      launchClaim,
      profileDirectory: {
        version: 1 as const,
        platform: "darwin" as const,
        canonicalPath: userDataDir,
        device: "1",
        inode: "2",
      },
    } satisfies ChromeProcessIdentity;
    const validCommandTokens = [
      executablePath,
      `--user-data-dir=${userDataDir}`,
      `--oracle-launch-claim=${launchClaim.generationId}:${launchClaim.nonce}`,
    ];
    const inspect = (processStartTime: string, commandTokens = validCommandTokens) =>
      profileState.inspectChromeProcessIdentityForTest(userDataDir, identity, {
        platform: "darwin",
        verifyProfileIdentity: async () => true,
        isProcessAlive: () => true,
        readProcessSnapshot: async () => ({
          pid: identity.pid,
          processStartTime,
          executablePath,
          commandLine: commandTokens.join(" "),
          commandTokens,
        }),
      });

    for (const observedIdentity of [
      "darwin-kernel-start:1785945427:287123",
      "darwin-audit-pidversion:7001",
    ]) {
      await expect(inspect(observedIdentity)).resolves.toBe("current");
    }
    await expect(
      inspect("darwin-audit-pidversion:7001", [
        executablePath,
        `--user-data-dir=${userDataDir}`,
        `--oracle-launch-claim=${launchClaim.generationId}:00000000-0000-4000-8000-000000007003`,
      ]),
    ).resolves.toBe("unavailable");
    await expect(inspect("darwin-sample-launch:2026-08-05T11:57:07.288-0400")).resolves.toBe(
      "exited",
    );
  });

  test("crash recovery without stable authority remains pending and never taskkills", async () => {
    const profileDir = String.raw`C:\Users\Oracle\AppData\Local\Temp\oracle-browser-session`;
    const identity = syntheticWindowsChromeIdentity(profileDir);
    const terminationCalls: Array<{ file: string; args: string[] }> = [];
    await expect(
      profileState.terminateRecordedChromeForProfileForTest(profileDir, identity, undefined, {
        platform: "win32",
        readOwner: async () => ({
          port: 12345,
          processIdentity: identity,
          disposition: "close-on-last-lease",
        }),
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

  test("bounds default process inspections and preserves authority after a command timeout", async () => {
    const timeoutError = Object.assign(new Error("process probe timed out"), {
      code: "ETIMEDOUT",
      killed: true,
    });
    const execFile = vi.fn();
    const execFileAsync = vi.fn(async (..._args: unknown[]) => {
      throw timeoutError;
    });
    Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
      value: execFileAsync,
    });
    const profileDir = String.raw`C:\Users\Oracle\AppData\Local\Temp\oracle-browser-session`;
    const identity = syntheticWindowsChromeIdentity(profileDir);
    let cleanupDir: string | undefined;

    try {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({ execFile }));
      // A static import already binds the real executor; reload to bind this test's timed-out boundary.
      const timedProfileState = await import("../../src/browser/profileState.js");

      await expect(
        timedProfileState.inspectChromeProcessIdentityForTest(profileDir, identity, {
          platform: "win32",
          verifyProfileIdentity: async () => true,
          isProcessAlive: () => true,
        }),
      ).resolves.toBe("unavailable");

      cleanupDir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-timeout-"));
      await writeNativeDevToolsFixture(cleanupDir, 12345);
      await expect(timedProfileState.cleanupStaleProfileState(cleanupDir)).resolves.toBe(false);
      expect(existsSync(path.join(cleanupDir, "DevToolsActivePort"))).toBe(true);

      expect(execFileAsync.mock.calls).toHaveLength(2);
      expect(execFileAsync.mock.calls[0]?.[0]).toBe("powershell.exe");
      expect(execFileAsync.mock.calls[1]?.[0]).toBe(
        process.platform === "win32" ? "powershell.exe" : "/usr/bin/pgrep",
      );
      if (process.platform !== "win32") {
        expect(execFileAsync.mock.calls[1]?.[1]).toEqual([
          "-i",
          "-f",
          "--",
          expect.stringContaining(path.resolve(cleanupDir)),
        ]);
      }
      for (const [, , options] of execFileAsync.mock.calls) {
        expect(options).toMatchObject({ timeout: 12_000 });
      }
    } finally {
      if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  test("rejects a cross-boot Linux PID/start-tick collision while accepting the recorded boot", async () => {
    const userDataDir = "/tmp/oracle-linux-generation";
    const identity = {
      pid: 4321,
      processStartTime: "linux:11111111-1111-4111-8111-111111111111:987654",
      executablePath: "/usr/bin/google-chrome",
      normalizedUserDataDir: userDataDir,
      launchNonce: "00000000-0000-4000-8000-000000009876",
      profileDirectory: {
        version: 1 as const,
        platform: "linux" as const,
        canonicalPath: userDataDir,
        device: "1",
        inode: "2",
      },
    } satisfies ChromeProcessIdentity;
    const verifyWithBoot = (bootId: string) =>
      profileState.verifyChromeProcessIdentityForTest(userDataDir, identity, {
        platform: "linux",
        readOwner: async () => ({
          port: 45_678,
          processIdentity: identity,
          disposition: "close-on-last-lease",
        }),
        readProcessSnapshot: async () => ({
          pid: identity.pid,
          processStartTime: `linux:${bootId}:987654`,
          executablePath: identity.executablePath,
          commandLine: `${identity.executablePath} --user-data-dir=${userDataDir}`,
        }),
        verifyProfileIdentity: async () => true,
        isProcessAlive: () => true,
      });

    await expect(verifyWithBoot("11111111-1111-4111-8111-111111111111")).resolves.toBe(true);
    await expect(verifyWithBoot("22222222-2222-4222-8222-222222222222")).resolves.toBe(false);
  });

  test.runIf(process.platform === "linux")(
    "captures and verifies a real Linux process through procfs generation data",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-linux-process-"));
      const profileDir = path.join(root, "profile with spaces");
      const chromeExecutable = path.join(root, "google-chrome");
      await mkdir(profileDir);
      await copyFile(process.execPath, chromeExecutable);
      await chmod(chromeExecutable, 0o755);
      const child = spawn(
        chromeExecutable,
        [
          "-e",
          "require('node:net').createServer().listen(0)",
          "--",
          `--user-data-dir=${profileDir}`,
        ],
        { stdio: "ignore" },
      );
      const exited = once(child, "exit");
      try {
        await once(child, "spawn");
        if (!child.pid) throw new Error("Linux Chrome fixture did not expose a pid");
        const identity = await profileState.captureChromeProcessIdentity(profileDir, child.pid);
        expect(identity.executablePath).toBe(chromeExecutable);
        expect(identity.processStartTime).toMatch(
          /^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/u,
        );
        await profileState.writeOracleChromeOwner(profileDir, {
          port: 45678,
          processIdentity: identity,
          disposition: "close-on-last-lease",
        });
        expect(
          JSON.parse(await readFile(path.join(profileDir, "oracle-chrome-owner.json"), "utf8")),
        ).toMatchObject({ processIdentity: { processStartTime: identity.processStartTime } });
        await expect(profileState.verifyChromeProcessIdentity(profileDir, identity)).resolves.toBe(
          true,
        );
        child.kill("SIGTERM");
        await exited;
        await expect(profileState.verifyChromeProcessIdentity(profileDir, identity)).resolves.toBe(
          false,
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited.catch(() => undefined);
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
      await writeNativeDevToolsFixture(profileDir, 12345);
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

  test("removes a matching profile through an isolated directory generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-delete-owned-"));
    const profileDir = path.join(root, "profile");
    try {
      await mkdir(profileDir);
      await writeFile(path.join(profileDir, "authorized-marker"), "remove");
      const identity = await profileState.captureProfileDirectoryIdentity(profileDir);
      await expect(
        profileState.removeProfileDirectoryIfIdentityMatchesForTest(profileDir, identity, {
          isChromeUsingUserDataDir: async () => false,
        }),
      ).resolves.toBe(true);
      expect(existsSync(profileDir)).toBe(false);
      expect((await readdir(root)).filter((entry) => entry.startsWith(".oracle-remove-"))).toEqual(
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("path replacement cannot redirect final profile deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-delete-retarget-"));
    const profileDir = path.join(root, "profile");
    const movedGeneration = path.join(root, "verified-generation");
    try {
      await mkdir(profileDir);
      await writeFile(path.join(profileDir, "authorized-marker"), "preserve");
      const identity = await profileState.captureProfileDirectoryIdentity(profileDir);
      await expect(
        profileState.removeProfileDirectoryIfIdentityMatchesForTest(profileDir, identity, {
          isChromeUsingUserDataDir: async () => false,
          beforeQuarantineRename: async () => {
            await rename(profileDir, movedGeneration);
            await mkdir(profileDir);
            await writeFile(path.join(profileDir, "replacement-marker"), "never-delete");
          },
        }),
      ).resolves.toBe(false);
      expect(existsSync(path.join(movedGeneration, "authorized-marker"))).toBe(true);
      expect(existsSync(path.join(profileDir, "replacement-marker"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("quarantine replacement cannot redirect final profile deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-quarantine-retarget-"));
    const profileDir = path.join(root, "profile");
    const movedGeneration = path.join(root, "verified-generation");
    let replacementPath: string | undefined;
    try {
      await mkdir(profileDir);
      await writeFile(path.join(profileDir, "authorized-marker"), "preserve");
      const identity = await profileState.captureProfileDirectoryIdentity(profileDir);
      await expect(
        profileState.removeProfileDirectoryIfIdentityMatchesForTest(profileDir, identity, {
          isChromeUsingUserDataDir: async () => false,
          beforeQuarantineDelete: async (quarantinePath) => {
            replacementPath = quarantinePath;
            await rename(quarantinePath, movedGeneration);
            await mkdir(quarantinePath);
            await writeFile(path.join(quarantinePath, "replacement-marker"), "never-delete");
          },
        }),
      ).resolves.toBe(false);
      expect(existsSync(path.join(movedGeneration, "authorized-marker"))).toBe(true);
      expect(replacementPath).toBeDefined();
      expect(existsSync(path.join(replacementPath ?? "", "replacement-marker"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("post-verification quarantine replacement preserves both directory generations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-quarantine-final-race-"));
    const profileDir = path.join(root, "profile");
    const movedGeneration = path.join(root, "verified-generation");
    let replacementPath: string | undefined;
    try {
      await mkdir(profileDir);
      await writeFile(path.join(profileDir, "authorized-marker"), "preserve");
      const identity = await profileState.captureProfileDirectoryIdentity(profileDir);
      await expect(
        profileState.removeProfileDirectoryIfIdentityMatchesForTest(profileDir, identity, {
          isChromeUsingUserDataDir: async () => false,
          afterQuarantineIdentityVerification: async (quarantinePath) => {
            replacementPath = quarantinePath;
            await rename(quarantinePath, movedGeneration);
            await mkdir(quarantinePath);
            await writeFile(path.join(quarantinePath, "replacement-marker"), "never-delete");
          },
        }),
      ).resolves.toBe(false);
      expect(existsSync(path.join(movedGeneration, "authorized-marker"))).toBe(true);
      expect(replacementPath).toBeDefined();
      expect(existsSync(path.join(replacementPath ?? "", "replacement-marker"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform !== "win32")(
    "profile deletion stays bound to the attested isolation root after substitution",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-bound-delete-"));
      const profileDir = path.join(root, "profile");
      const movedRootPath = path.join(root, "moved-isolation-root");
      await mkdir(path.join(profileDir, "nested"), { recursive: true });
      await writeFile(path.join(profileDir, "nested", "owned-marker"), "delete");
      try {
        const identity = await profileState.captureProfileDirectoryIdentity(profileDir);
        let isolatedRootPath: string | undefined;
        await expect(
          profileState.removeProfileDirectoryIfIdentityMatchesForTest(profileDir, identity, {
            isChromeUsingUserDataDir: async () => false,
            afterRemovalChildAttestation: async (rootPath) => {
              isolatedRootPath = rootPath;
              await rename(rootPath, movedRootPath);
              await mkdir(rootPath);
              await writeFile(path.join(rootPath, "replacement-marker"), "preserve");
            },
          }),
        ).rejects.toThrow(/identity changed/i);
        expect(isolatedRootPath).toBeDefined();
        await expect(stat(path.join(movedRootPath, "generation"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          readFile(path.join(isolatedRootPath ?? "", "replacement-marker"), "utf8"),
        ).resolves.toBe("preserve");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("profile deletion replays a durable post-isolation cleanup after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-delete-replay-"));
    const profileDir = path.join(root, "profile");
    await mkdir(profileDir);
    await writeFile(path.join(profileDir, "owned-marker"), "delete");
    try {
      const identity = await profileState.captureProfileDirectoryIdentity(profileDir);
      await expect(
        profileState.removeProfileDirectoryIfIdentityMatchesForTest(profileDir, identity, {
          isChromeUsingUserDataDir: async () => false,
          afterRemovalChildAttestation: async () => {
            throw new Error("simulated crash after isolation");
          },
        }),
      ).rejects.toThrow("simulated crash after isolation");
      expect((await readdir(root)).some((entry) => entry.endsWith(".cleanup-journal.json"))).toBe(
        true,
      );

      await expect(profileState.replayPendingProfileDirectoryRemovals(profileDir)).resolves.toBe(
        undefined,
      );
      expect(
        (await readdir(root)).filter((entry) => entry.endsWith(".cleanup-journal.json")),
      ).toEqual([]);
      expect(existsSync(profileDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("profile deletion replay is a no-op when the parent directory is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-delete-missing-parent-"));
    const profileDir = path.join(root, "missing", "profile");
    try {
      await expect(profileState.replayPendingProfileDirectoryRemovals(profileDir)).resolves.toBe(
        undefined,
      );
      await expect(profileState.cleanupStaleProfileState(profileDir)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unrelated pending cleanup journals do not block exact profile deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-delete-unrelated-replay-"));
    const profileDir = path.join(root, "profile");
    const unrelatedJournal = path.join(root, ".oracle-remove-unrelated.cleanup-journal.json");
    await mkdir(profileDir);
    await writeFile(path.join(profileDir, "owned-marker"), "delete");
    await writeFile(unrelatedJournal, "not-json");
    try {
      const identity = await profileState.captureProfileDirectoryIdentity(profileDir);
      await expect(
        profileState.removeProfileDirectoryIfIdentityMatchesForTest(profileDir, identity, {
          isChromeUsingUserDataDir: async () => false,
        }),
      ).resolves.toBe(true);
      expect(existsSync(profileDir)).toBe(false);
      expect(existsSync(unrelatedJournal)).toBe(true);
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
      const identity = await physicalChromeIdentity(profileDir);
      await rename(profileDir, movedDir);
      await mkdir(profileDir);
      await expect(
        profileState.writeOracleChromeOwner(profileDir, {
          port: 12345,
          processIdentity: identity,
          disposition: "close-on-last-lease",
        }),
      ).rejects.toThrow(/does not belong|physical profile/i);
      expect(existsSync(path.join(profileDir, "oracle-chrome-owner.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips manual-login cleanup when DevTools port is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await writeNativeDevToolsFixture(dir, 12345);
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
      await writeNativeDevToolsFixture(dir, 12345);
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
      await writeNativeDevToolsFixture(dir, 12345);
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

  test("migrates the exact dead legacy profile lock file before directory publication", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-legacy-lock-"));
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await once(child, "exit");
    if (!child.pid) throw new Error("Missing child pid");
    const lockPath = path.join(dir, "oracle-automation.lock");
    const legacyRaw = `${JSON.stringify({
      pid: child.pid,
      lockId: "legacy-lock-generation",
      createdAt: new Date().toISOString(),
      sessionId: "legacy-session",
    })}\n`;
    try {
      await writeFile(lockPath, legacyRaw, "utf8");
      const lock = await profileState.acquireProfileRunLock(dir, {
        timeoutMs: 500,
        pollMs: 50,
        sessionId: "replacement-session",
      });
      expect(lock).not.toBeNull();
      expect((await stat(lockPath)).isDirectory()).toBe(true);
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves an exact legacy profile lock while its pid is alive", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-legacy-live-"));
    const lockPath = path.join(dir, "oracle-automation.lock");
    const legacyRaw = `${JSON.stringify({
      pid: process.pid,
      lockId: "live-legacy-lock",
      createdAt: new Date().toISOString(),
      sessionId: "live-legacy-session",
    })}\n`;
    try {
      await writeFile(lockPath, legacyRaw, "utf8");
      await expect(
        profileState.acquireProfileRunLock(dir, { timeoutMs: 150, pollMs: 50 }),
      ).rejects.toThrow(/profile lock/i);
      await expect(readFile(lockPath, "utf8")).resolves.toBe(legacyRaw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for a legacy profile lock with unknown fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-legacy-schema-"));
    const lockPath = path.join(dir, "oracle-automation.lock");
    const raw = `${JSON.stringify({
      pid: 61_061,
      lockId: "unknown-schema-lock",
      createdAt: new Date().toISOString(),
      sessionId: "unknown-schema-session",
      extraAuthority: true,
    })}\n`;
    try {
      await writeFile(lockPath, raw, "utf8");
      await expect(
        profileState.acquireProfileRunLock(dir, { timeoutMs: 150, pollMs: 50 }),
      ).rejects.toThrow(/profile lock/i);
      await expect(readFile(lockPath, "utf8")).resolves.toBe(raw);
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

  test("binds a port-zero Chrome process to its native active port", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    const processList = `
      456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=0 --user-data-dir=${dir} about:blank
    `;

    expect(
      profileState.findChromeDebugTargetForProfileFromProcessListForTest(processList, dir, 64305),
    ).toEqual({ pid: 456, port: 64305 });
  });

  test("classifies an exact launch claim before DevTools is ready without adopting profile conflicts", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    const claim = {
      version: 1 as const,
      generationId: "10000000-0000-4000-8000-000000000001",
      nonce: "20000000-0000-4000-8000-000000000002",
    };
    const processList = `
      455 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer --user-data-dir=${dir}
      456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=0 --user-data-dir=${dir} --oracle-launch-claim=${claim.generationId}:${claim.nonce}
      457 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=${dir} --oracle-launch-claim=${claim.generationId}:30000000-0000-4000-8000-000000000003
      789 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/other
    `;

    expect(
      profileState.inspectChromeProcessesForLaunchClaimFromProcessListForTest(
        processList,
        dir,
        claim,
      ),
    ).toEqual({
      exactMatches: [{ pid: 456, port: null }],
      conflictingProfilePids: [457],
    });
    expect(
      profileState.inspectChromeProcessesForLaunchClaimFromProcessListForTest(
        processList,
        dir,
        claim,
        64_305,
      ).exactMatches,
    ).toEqual([{ pid: 456, port: 64_305 }]);
  });

  test("classifies a quoted Windows launch claim without adopting an unclaimed profile process", () => {
    const dir = String.raw`C:\Users\Oracle\AppData\Local\Temp\oracle-browser-session`;
    const claim = {
      version: 1 as const,
      generationId: "30000000-0000-4000-8000-000000000003",
      nonce: "40000000-0000-4000-8000-000000000004",
    };
    const processList = String.raw`
      567 "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=0 --user-data-dir="${dir}" --oracle-launch-claim=${claim.generationId}:${claim.nonce}
      568 "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="${dir}"
    `;

    expect(
      profileState.inspectChromeProcessesForLaunchClaimFromProcessListForTest(
        processList,
        dir,
        claim,
        61_234,
        "win32",
      ),
    ).toEqual({
      exactMatches: [{ pid: 567, port: 61_234 }],
      conflictingProfilePids: [568],
    });
  });
});
