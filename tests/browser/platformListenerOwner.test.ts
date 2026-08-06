import { describe, expect, test, vi } from "vitest";
import {
  resolveListeningPortOwner,
  type ListenerOwnerCommandExecutor,
  type PlatformListenerOwnerDeps,
} from "../../src/browser/platformListenerOwner.js";
import { resolveWindowsPowerShellExecutable } from "../../src/windowsSystemExecutable.js";

const PORT = 64_305;
const EXPECTED_PID = 4321;
const OTHER_PID = 9999;
const LINUX_GENERATION = "linux:11111111-1111-4111-8111-111111111111:987654";
const WINDOWS_START = "2026-08-06T12:34:56.1234567Z";
const TCP_HEADER =
  "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
const TCP_LISTENER =
  "0: 0100007F:FB31 00000000:0000 0A 00000000:00000000 00:00000000 00000000 501 0 424242 1";

function linuxListenerDeps(ownerPid: number | null): PlatformListenerOwnerDeps {
  return {
    platform: "linux",
    readFile: async (file) =>
      file === "/proc/net/tcp" ? `${TCP_HEADER}\n${TCP_LISTENER}\n` : `${TCP_HEADER}\n`,
    readDirectory: async (directory) => {
      if (directory === "/proc") return [String(EXPECTED_PID), String(OTHER_PID), "self"];
      if (directory === `/proc/${EXPECTED_PID}/fd`) return ["7"];
      if (directory === `/proc/${OTHER_PID}/fd`) return ["8"];
      throw Object.assign(new Error("missing process"), { code: "ENOENT" });
    },
    readLink: async (descriptor) => {
      if (
        ownerPid !== null &&
        descriptor === `/proc/${ownerPid}/fd/${ownerPid === EXPECTED_PID ? "7" : "8"}`
      ) {
        return "socket:[424242]";
      }
      return "socket:[111111]";
    },
    readProcessGeneration: async () => LINUX_GENERATION,
  };
}

describe("Darwin DevTools listener ownership", () => {
  test("resolves the matching kernel listener pid", async () => {
    const execute = vi.fn<ListenerOwnerCommandExecutor>(async () => ({
      stdout: `p${EXPECTED_PID}\n`,
    }));

    await expect(resolveListeningPortOwner(PORT, { platform: "darwin", execute })).resolves.toEqual(
      { pid: EXPECTED_PID },
    );
    expect(execute).toHaveBeenCalledWith("/usr/sbin/lsof", [
      "-nP",
      "-a",
      `-iTCP:${PORT}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
  });

  test("reports a mismatched kernel listener pid", async () => {
    await expect(
      resolveListeningPortOwner(PORT, {
        platform: "darwin",
        execute: async () => ({ stdout: `p${OTHER_PID}\n` }),
      }),
    ).resolves.toEqual({ pid: OTHER_PID });
  });

  test("fails closed when listener ownership is ambiguous or unavailable", async () => {
    for (const execute of [
      async () => ({ stdout: `p${EXPECTED_PID}\np${OTHER_PID}\n` }),
      async () => {
        throw new Error("lsof unavailable");
      },
    ]) {
      await expect(
        resolveListeningPortOwner(PORT, { platform: "darwin", execute }),
      ).resolves.toBeNull();
    }
  });
});

describe("Linux DevTools listener ownership", () => {
  test("binds the matching procfs listener pid to its exact process generation", async () => {
    await expect(resolveListeningPortOwner(PORT, linuxListenerDeps(EXPECTED_PID))).resolves.toEqual(
      {
        pid: EXPECTED_PID,
        processGeneration: LINUX_GENERATION,
      },
    );
  });

  test("reports a mismatched procfs listener pid and generation", async () => {
    await expect(resolveListeningPortOwner(PORT, linuxListenerDeps(OTHER_PID))).resolves.toEqual({
      pid: OTHER_PID,
      processGeneration: LINUX_GENERATION,
    });
  });

  test("fails closed when procfs cannot resolve a listener owner", async () => {
    await expect(resolveListeningPortOwner(PORT, linuxListenerDeps(null))).resolves.toBeNull();
  });
});

describe("Windows DevTools listener ownership", () => {
  test("binds the matching kernel TCP owner to its exact CIM process generation", async () => {
    const execute = vi.fn<ListenerOwnerCommandExecutor>(async () => ({
      stdout: `${EXPECTED_PID}|${WINDOWS_START}`,
    }));

    await expect(resolveListeningPortOwner(PORT, { platform: "win32", execute })).resolves.toEqual({
      pid: EXPECTED_PID,
      processGeneration: `win32:${WINDOWS_START}`,
    });
    expect(execute.mock.calls[0]?.[0]).toBe(resolveWindowsPowerShellExecutable());
    expect(execute.mock.calls[0]?.[1]?.at(-1)).toContain(
      `Get-NetTCPConnection -State Listen -LocalPort ${PORT}`,
    );
    expect(execute.mock.calls[0]?.[1]?.at(-1)).toContain("Get-CimInstance Win32_Process");
  });

  test("reports a mismatched kernel TCP listener pid and generation", async () => {
    await expect(
      resolveListeningPortOwner(PORT, {
        platform: "win32",
        execute: async () => ({ stdout: `${OTHER_PID}|${WINDOWS_START}` }),
      }),
    ).resolves.toEqual({
      pid: OTHER_PID,
      processGeneration: `win32:${WINDOWS_START}`,
    });
  });

  test("fails closed when Windows listener ownership cannot be resolved", async () => {
    for (const execute of [
      async () => ({ stdout: "" }),
      async () => {
        throw new Error("Get-NetTCPConnection unavailable");
      },
    ]) {
      await expect(
        resolveListeningPortOwner(PORT, { platform: "win32", execute }),
      ).resolves.toBeNull();
    }
  });
});
