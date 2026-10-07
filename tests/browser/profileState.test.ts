import { afterEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as profileState from "../../src/browser/profileState.js";

describe("profileState", () => {
  test("resolves and validates the exact remote browser identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/browser-a",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        profileState.resolveRemoteChromeBrowserIdentity({
          host: "127.0.0.1",
          port: 9223,
          attempts: 1,
        }),
      ).resolves.toEqual({
        browserId: "browser-a",
        browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:9223/json/version",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(() =>
        profileState.browserIdFromWebSocketEndpoint("ws://127.0.0.1:9223/page/a"),
      ).toThrow(/invalid browser WebSocket URL/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("reconstructs equivalent loopback advertisements with the configured authority", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://localhost:9223/devtools/browser/browser-a",
        }),
      }),
    );
    try {
      await expect(
        profileState.resolveRemoteChromeBrowserIdentity({
          host: "127.0.0.1",
          port: 9223,
          attempts: 1,
        }),
      ).resolves.toEqual({
        browserId: "browser-a",
        browserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("requires wss for an https-configured DevTools authority", () => {
    expect(
      profileState.bindRemoteChromeBrowserWebSocketEndpoint({
        browserWSEndpoint: "wss://debug.example.test/devtools/browser/browser-a",
        host: "debug.example.test",
        port: 443,
        httpProtocol: "https:",
      }),
    ).toEqual({
      browserId: "browser-a",
      browserWSEndpoint: "wss://debug.example.test/devtools/browser/browser-a",
    });
    expect(() =>
      profileState.bindRemoteChromeBrowserWebSocketEndpoint({
        browserWSEndpoint: "ws://debug.example.test:443/devtools/browser/browser-a",
        host: "debug.example.test",
        port: 443,
        httpProtocol: "https:",
      }),
    ).toThrow(/authority/i);
  });

  test.each([
    ["wrong host", "ws://attacker.invalid:9223/devtools/browser/browser-a", /authority/i],
    ["wrong port", "ws://127.0.0.1:9444/devtools/browser/browser-a", /authority/i],
    ["userinfo", "ws://user@127.0.0.1:9223/devtools/browser/browser-a", /invalid/i],
    ["query", "ws://127.0.0.1:9223/devtools/browser/browser-a?token=secret", /invalid/i],
    ["fragment", "ws://127.0.0.1:9223/devtools/browser/browser-a#secret", /invalid/i],
    ["empty userinfo", "ws://@127.0.0.1:9223/devtools/browser/browser-a", /invalid/i],
    ["empty query", "ws://127.0.0.1:9223/devtools/browser/browser-a?", /invalid/i],
    ["empty fragment", "ws://127.0.0.1:9223/devtools/browser/browser-a#", /invalid/i],
    ["wrong protocol", "wss://127.0.0.1:9223/devtools/browser/browser-a", /authority/i],
  ])("rejects a %s browser WebSocket advertisement", async (_label, endpoint, error) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: endpoint }),
      }),
    );
    try {
      await expect(
        profileState.resolveRemoteChromeBrowserIdentity({
          host: "127.0.0.1",
          port: 9223,
          attempts: 1,
        }),
      ).rejects.toThrow(error);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("rejects malformed remote browser identity responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Browser: "Chrome" }) }),
    );
    try {
      await expect(
        profileState.resolveRemoteChromeBrowserIdentity({ port: 9223, attempts: 1 }),
      ).rejects.toThrow(/missing webSocketDebuggerUrl/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

  test.skipIf(process.platform === "win32")(
    "waits for Chrome profile processes before returning from termination",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-terminate-"));
      // Upstream identifies Chrome by its executable name, so run the fixture through a
      // "chrome"-named link to Node instead of passing "chrome" as a later argument.
      const binDir = await mkdtemp(path.join(os.tmpdir(), "oracle-fake-chrome-"));
      const fakeChrome = path.join(binDir, "chrome");
      await symlink(process.execPath, fakeChrome);
      const child = spawn(
        fakeChrome,
        [
          // A leading "--" switch marks where the executable path ends for the identity parser.
          "--eval",
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            "const profile = process.argv[1];",
            'process.on("SIGTERM", () => process.send?.("sigterm"));',
            'process.on("message", (message) => {',
            '  if (message !== "exit") return;',
            "  fs.mkdirSync(profile, { recursive: true });",
            '  fs.writeFileSync(path.join(profile, "late-write"), "late");',
            "  process.exit(0);",
            "});",
            'process.send?.("ready");',
          ].join(" "),
          dir,
          `--user-data-dir=${dir}`,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );

      try {
        if (!child.pid) throw new Error("Failed to start Chrome fixture");
        await once(child, "message");
        await profileState.writeChromePid(dir, child.pid);

        const signalReceived = once(child, "message").then(([message]) => {
          expect(message).toBe("sigterm");
          return "signal" as const;
        });
        const termination = profileState.terminateRecordedChromeForProfile(dir);
        await expect(
          Promise.race([termination.then(() => "terminated" as const), signalReceived]),
        ).resolves.toBe("signal");

        child.send("exit");
        await expect(termination).resolves.toBe(true);
        expect(profileState.isProcessAlive(child.pid)).toBe(false);

        await rm(dir, { recursive: true, force: true });
        expect(existsSync(dir)).toBe(false);
      } finally {
        child.kill("SIGKILL");
        await rm(dir, { recursive: true, force: true });
        await rm(binDir, { recursive: true, force: true });
      }
    },
  );

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
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/other",
        dir,
      ),
    ).toBe(false);
    expect(profileState.isChromeCommandForUserDataDirForTest("node worker.js", dir)).toBe(false);
  });

  test.runIf(process.platform === "win32")(
    "matches recorded Windows Chrome commands case-insensitively",
    () => {
      expect(
        profileState.isChromeCommandForUserDataDirForTest(
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\USERS\\XING_\\.ORACLE\\BROWSER-PROFILE',
          "c:\\users\\xing_\\.oracle\\browser-profile",
        ),
      ).toBe(true);
      expect(
        profileState.isChromeCommandForUserDataDirForTest(
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Oracle\\manual-profile-backup"',
          "C:\\Oracle\\manual-profile",
        ),
      ).toBe(false);
      expect(
        profileState.isChromeCommandForUserDataDirForTest(
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir "C:\\Oracle\\manual profile"',
          "c:\\oracle\\manual profile\\",
        ),
      ).toBe(true);
      expect(
        profileState.isChromeCommandForUserDataDirForTest(
          'node.exe worker.js --label=chrome --user-data-dir="C:\\Oracle\\manual-profile"',
          "C:\\Oracle\\manual-profile",
        ),
      ).toBe(false);
    },
  );

  test("reads the current process start identity", async () => {
    const startedAt = await profileState.readProcessStartTimeMs(process.pid);
    expect(startedAt).not.toBeNull();
    expect(Math.abs((startedAt ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000);
  });

  test("keeps process identity stable when the wall clock is corrected", async () => {
    const before = await profileState.readProcessStartTimeMs(process.pid);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      expect(await profileState.readProcessStartTimeMs(process.pid)).toBe(before);
    } finally {
      clock.mockRestore();
    }
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

test("matches a quoted complete user-data-dir argument without accepting a sibling profile", async () => {
  const { isChromeCommandForUserDataDirForTest } =
    await import("../../src/browser/profileState.js");
  const profile = path.resolve("profile with spaces");
  const command = `chrome "--user-data-dir=${profile}" --remote-debugging-port=9222`;
  expect(isChromeCommandForUserDataDirForTest(command, profile)).toBe(true);
  expect(isChromeCommandForUserDataDirForTest(command, profile + "-other")).toBe(false);
});

test("does not identify a later chrome-named argument as the process executable", async () => {
  const { isChromeCommandForUserDataDirForTest } =
    await import("../../src/browser/profileState.js");
  const profile = path.resolve("profile");
  expect(
    isChromeCommandForUserDataDirForTest(
      `/usr/bin/node /tmp/chrome --user-data-dir=${profile}`,
      profile,
    ),
  ).toBe(false);
});

test("does not erase meaningful whitespace from a quoted profile path", async () => {
  const { isChromeCommandForUserDataDirForTest } =
    await import("../../src/browser/profileState.js");
  const profile = path.resolve("profile");
  expect(
    isChromeCommandForUserDataDirForTest(`chrome --user-data-dir="${profile} "`, profile),
  ).toBe(false);
});

test("refuses ambiguous duplicate profile arguments", async () => {
  const { isChromeCommandForUserDataDirForTest } =
    await import("../../src/browser/profileState.js");
  const profile = path.resolve("profile");
  expect(
    isChromeCommandForUserDataDirForTest(
      `chrome --user-data-dir="${profile}" --user-data-dir="${profile}-other"`,
      profile,
    ),
  ).toBe(false);
});

test.each([
  "google-chrome-beta",
  "google-chrome-dev",
  "google-chrome-unstable",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
])("recognizes the configured Chrome channel executable %s", (executable) => {
  const profile = path.resolve("shared profile");
  expect(
    profileState.isChromeCommandForUserDataDirForTest(
      `${executable} --user-data-dir="${profile}" --remote-debugging-port=9222`,
      profile,
    ),
  ).toBe(true);
  expect(
    profileState.isChromeCommandForUserDataDirForTest(
      `node ${executable} --user-data-dir="${profile}"`,
      profile,
    ),
  ).toBe(false);
});

test.each(["--remote-debugging-port=9222", "about:blank"])(
  "preserves spaces before POSIX argument %s",
  async (suffix) => {
    const { isChromeCommandForUserDataDirForTest } =
      await import("../../src/browser/profileState.js");
    const profile = path.resolve("Shared Profile");
    const command = `chrome --user-data-dir=${profile} ${suffix}`;
    expect(isChromeCommandForUserDataDirForTest(command, profile)).toBe(true);
    expect(isChromeCommandForUserDataDirForTest(command, path.resolve("Shared"))).toBe(false);
  },
);

describe("verifyDevToolsReachable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("brackets an IPv6 host when probing DevTools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      profileState.verifyDevToolsReachable({ port: 9222, host: "::1" }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("http://[::1]:9222/json/version", {
      signal: expect.any(AbortSignal),
    });
    const [versionUrl] = fetchMock.mock.calls[0] as [string];
    expect(() => new URL(versionUrl)).not.toThrow();
  });

  test("keeps an IPv4 host unchanged when probing DevTools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      profileState.verifyDevToolsReachable({ port: 9222, host: "127.0.0.1" }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version", {
      signal: expect.any(AbortSignal),
    });
  });

  test("clears the abort timer when the probe rejects", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      profileState.verifyDevToolsReachable({ port: 9222, attempts: 1 }),
    ).resolves.toEqual({ ok: false, error: "ECONNREFUSED" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
