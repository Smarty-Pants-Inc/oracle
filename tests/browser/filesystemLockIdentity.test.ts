import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
} from "../../src/browser/filesystemLock.js";
import type {
  CrashRecoverableFilesystemLock,
  ProcessLiveness,
} from "../../src/browser/filesystemLock.js";
import { createPlatformProcessGenerationProvider } from "../../src/browser/platformProcessGeneration.js";
import { createProcessIdentityProvider } from "./filesystemLockTestHelpers.js";
const WINDOWS_SYSTEM_ROOT = String.raw`D:\Windows`;
const WINDOWS_TRUSTED_PROCESS_PROBE = String.raw`${WINDOWS_SYSTEM_ROOT}\System32\WindowsPowerShell\v1.0\powershell.exe`;

test("ignores a hostile PATH when reading an exact Windows CIM creation generation", async () => {
  const attackerPowerShell = vi.fn(async () => ({ stdout: "1900-01-01T00:00:00.0000000Z\n" }));
  const execute = vi.fn(async (file: string, _args: string[]) => {
    if (file === "powershell.exe") return attackerPowerShell();
    if (file !== WINDOWS_TRUSTED_PROCESS_PROBE) {
      throw new Error(`Unexpected process probe: ${file}`);
    }
    return { stdout: "2026-08-05T12:34:56.1234567Z\n" };
  });
  const provider = createPlatformProcessGenerationProvider({
    platform: "win32",
    execute,
    windowsSystemRoot: WINDOWS_SYSTEM_ROOT,
  });
  const identity = await provider.readProcessGeneration(10_005);
  const retryIdentity = await provider.readProcessGeneration(10_005);

  expect(identity).toBe("win32:2026-08-05T12:34:56.1234567Z");
  expect(retryIdentity).toBe(identity);
  expect(attackerPowerShell).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]?.[0]).toBe(WINDOWS_TRUSTED_PROCESS_PROBE);
  expect(execute.mock.calls[0]?.[1]?.at(-1)).toContain(
    "Get-CimInstance Win32_Process -Filter 'ProcessId = 10005'",
  );
  expect(execute.mock.calls[0]?.[1]?.at(-1)).toContain("$process.CreationDate.ToUniversalTime()");
  expect(execute.mock.calls[0]?.[1]?.at(-1)).not.toContain("Get-Process");

  await expect(
    createPlatformProcessGenerationProvider({
      platform: "win32",
      execute: async () => ({ stdout: "10005" }),
      windowsSystemRoot: WINDOWS_SYSTEM_ROOT,
    }).readProcessGeneration(10_005),
  ).resolves.toBeNull();
  await expect(
    createPlatformProcessGenerationProvider({
      platform: "win32",
      execute: async () => {
        throw new Error("CIM unavailable");
      },
      windowsSystemRoot: WINDOWS_SYSTEM_ROOT,
    }).readProcessGeneration(10_005),
  ).resolves.toBeNull();
});

test("fails closed when the trusted Windows process probe is unavailable", async () => {
  const execute = vi.fn(async () => ({ stdout: "2026-08-05T12:34:56.1234567Z\n" }));
  const provider = createPlatformProcessGenerationProvider({
    platform: "win32",
    execute,
    trustedProcessProbe: null,
  });

  await expect(provider.readProcessGeneration(10_005)).resolves.toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

test("fails closed before execution when Windows SystemRoot is invalid", async () => {
  const execute = vi.fn(async () => ({ stdout: "2026-08-05T12:34:56.1234567Z\n" }));
  const provider = createPlatformProcessGenerationProvider({
    platform: "win32",
    execute,
    windowsSystemRoot: String.raw`..\Windows`,
  });

  await expect(provider.readProcessGeneration(10_005)).resolves.toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

test("uses the Darwin audit pidversion rather than second-resolution lstart", async () => {
  let pidVersion = 7001;
  const execute = vi.fn(async (file: string) => {
    if (file !== "/usr/bin/lsappinfo") throw new Error(`Unexpected process query: ${file}`);
    return {
      stdout: `"Google Chrome" ASN:0x0-0x1234: pid = 4321 token=[sess=100020 pid=4321 uid:501,501,501 g:20,20 pV:${pidVersion}]\n`,
    };
  });
  const provider = createPlatformProcessGenerationProvider({ platform: "darwin", execute });

  const original = await provider.readProcessGeneration(4321);
  pidVersion = 7002; // Same synthetic lstart second; the audit pidversion is the generation.
  const replacement = await provider.readProcessGeneration(4321);

  expect(original).toBe("darwin-audit-pidversion:7001");
  expect(replacement).toBe("darwin-audit-pidversion:7002");
  expect(replacement).not.toBe(original);
  expect(execute.mock.calls.every(([file]) => file === "/usr/bin/lsappinfo")).toBe(true);
});

test("falls back from malformed or mismatched Darwin audit identity", async () => {
  for (const appInfo of [
    "pid = 4321 token=[pid=4321 pV:not-a-number]",
    "pid = 4321 token=[pid=9876 pV:7001]",
    "pid = 9876 token=[pid=4321 pV:7001]",
  ]) {
    const execute = vi.fn(async (file: string) => {
      if (file === "/usr/bin/lsappinfo") return { stdout: appInfo };
      if (file === "/usr/bin/python3") return { stdout: "4321:1785945427:287123\n" };
      throw new Error(`Unexpected process query: ${file}`);
    });
    const provider = createPlatformProcessGenerationProvider({ platform: "darwin", execute });

    await expect(provider.readProcessGeneration(4321)).resolves.toBe(
      "darwin-kernel-start:1785945427:287123",
    );
    expect(execute.mock.calls.map(([file]) => file)).toEqual([
      "/usr/bin/lsappinfo",
      "/usr/bin/python3",
    ]);
  }
});

test("uses the kernel microsecond launch generation for an ordinary Darwin CLI process", async () => {
  const execute = vi.fn(async (file: string, _args: string[]) => {
    if (file === "/usr/bin/lsappinfo") {
      return { stdout: "No LaunchServices application registered for pid 4321\n" };
    }
    if (file === "/usr/bin/python3") return { stdout: "4321:1785945427:287123\n" };
    throw new Error(`Unexpected process query: ${file}`);
  });
  const provider = createPlatformProcessGenerationProvider({ platform: "darwin", execute });

  await expect(provider.readProcessGeneration(4321)).resolves.toBe(
    "darwin-kernel-start:1785945427:287123",
  );
  expect(execute).toHaveBeenNthCalledWith(1, "/usr/bin/lsappinfo", ["info", "4321"]);
  expect(execute.mock.calls[1]?.[0]).toBe("/usr/bin/python3");
  expect(execute.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["-c", "4321"]));

  const mismatchedKernelProvider = createPlatformProcessGenerationProvider({
    platform: "darwin",
    execute: async (file) => ({
      stdout:
        file === "/usr/bin/lsappinfo"
          ? "No LaunchServices application registered for pid 4321\n"
          : file === "/usr/bin/python3"
            ? "9876:1785945427:287123\n"
            : "",
    }),
  });
  await expect(mismatchedKernelProvider.readProcessGeneration(4321)).resolves.toBeNull();
});

test("uses sample launch time only when the fast kernel probe is unavailable", async () => {
  const sampleOutput = [
    "Analysis of sampling node (pid 4321) every 1000 milliseconds",
    "Process:         node [4321]",
    "Launch Time:     2026-08-05 11:57:07.287 -0400",
  ].join("\n");
  const execute = vi.fn(async (file: string) => {
    if (file === "/usr/bin/lsappinfo" || file === "/usr/bin/python3") return { stdout: "" };
    if (file === "/usr/bin/sample") return { stdout: sampleOutput };
    throw new Error(`Unexpected process query: ${file}`);
  });
  const provider = createPlatformProcessGenerationProvider({ platform: "darwin", execute });

  await expect(provider.readProcessGeneration(4321)).resolves.toBe(
    "darwin-sample-launch:2026-08-05T11:57:07.287-0400",
  );
  expect(execute.mock.calls.map(([file]) => file)).toEqual([
    "/usr/bin/lsappinfo",
    "/usr/bin/python3",
    "/usr/bin/sample",
  ]);
  expect(execute).toHaveBeenNthCalledWith(3, "/usr/bin/sample", [
    "4321",
    "1",
    "1",
    "-file",
    "/dev/stdout",
  ]);

  const mismatchedProvider = createPlatformProcessGenerationProvider({
    platform: "darwin",
    execute: async (file) => ({
      stdout:
        file === "/usr/bin/lsappinfo" || file === "/usr/bin/python3"
          ? ""
          : sampleOutput.replace("[4321]", "[9876]"),
    }),
  });
  await expect(mismatchedProvider.readProcessGeneration(4321)).resolves.toBeNull();
});

test("keeps Linux boot-id and start-ticks as a stable exact generation", async () => {
  const bootId = "11111111-1111-4111-8111-111111111111";
  const statForStartTicks = (startTicks: string) => {
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = "S";
    fields[19] = startTicks;
    return `4321 (chrome) ${fields.join(" ")}`;
  };
  const statReads = [statForStartTicks("987654"), statForStartTicks("987654")];
  const provider = createPlatformProcessGenerationProvider({
    platform: "linux",
    readFile: async (file) => (file.endsWith("/stat") ? (statReads.shift() ?? "") : `${bootId}\n`),
  });

  await expect(provider.readProcessGeneration(4321)).resolves.toBe(`linux:${bootId}:987654`);

  const replacementReads = [statForStartTicks("987654"), statForStartTicks("987655")];
  const replacementProvider = createPlatformProcessGenerationProvider({
    platform: "linux",
    readFile: async (file) =>
      file.endsWith("/stat") ? (replacementReads.shift() ?? "") : `${bootId}\n`,
  });
  await expect(replacementProvider.readProcessGeneration(4321)).resolves.toBeNull();
});

describe("crash-recoverable filesystem lock", () => {
  test("fails before publishing a lock when process generation is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "missing-parent", "recovery.lock");
    try {
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(10_000, async () => null),
          },
        ),
      ).rejects.toThrow(/without a stable process generation/i);
      await expect(stat(path.dirname(lockPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes a Darwin lock for an ordinary CLI process generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const generationProvider = createPlatformProcessGenerationProvider({
      platform: "darwin",
      execute: async (file) => {
        if (file === "/usr/bin/lsappinfo") return { stdout: "" };
        if (file === "/usr/bin/python3") return { stdout: "4321:1785945427:287123\n" };
        throw new Error(`Unexpected process query: ${file}`);
      },
    });
    try {
      const lock = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            4321,
            generationProvider.readProcessGeneration,
            () => "alive",
            "darwin",
          ),
        },
      );
      expect(lock.owner.processStartIdentity).toBe("darwin-kernel-start:1785945427:287123");
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a live Darwin owner active when audit pidversion appears after sample fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const ownerPid = 4_321;
    const contenderPid = 5_432;
    let auditIdentityAvailable = false;
    const execute = vi.fn(async (file: string, args: string[]) => {
      if (file === "/usr/bin/lsappinfo") {
        const pid = Number(args[1]);
        return {
          stdout: auditIdentityAvailable
            ? `"node" ASN:0x0-0x1234: pid = ${pid} token=[pid=${pid} pV:${pid + 7_000}]\n`
            : "",
        };
      }
      if (file === "/usr/bin/python3") return { stdout: "" };
      if (file === "/usr/bin/sample") {
        const pid = Number(args[0]);
        return {
          stdout: [
            `Analysis of sampling node (pid ${pid}) every 1000 milliseconds`,
            `Process:         node [${pid}]`,
            "Launch Time:     2026-08-05 11:57:07.287 -0400",
          ].join("\n"),
        };
      }
      throw new Error(`Unexpected process query: ${file}`);
    });
    const generationProvider = createPlatformProcessGenerationProvider({
      platform: "darwin",
      execute,
    });
    const original = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(
          ownerPid,
          generationProvider.readProcessGeneration,
          () => "alive",
          "darwin",
        ),
      },
    );

    try {
      expect(original.owner.processStartIdentity).toBe(
        "darwin-sample-launch:2026-08-05T11:57:07.287-0400",
      );
      const ownerRaw = await readFile(path.join(lockPath, "owner.json"), "utf8");
      auditIdentityAvailable = true;
      const beforeStaleLockQuarantine = vi.fn(async () => undefined);

      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(
              contenderPid,
              generationProvider.readProcessGeneration,
              () => "alive",
              "darwin",
            ),
            beforeStaleLockQuarantine,
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      expect(beforeStaleLockQuarantine).not.toHaveBeenCalled();
      await expect(readFile(path.join(lockPath, "owner.json"), "utf8")).resolves.toBe(ownerRaw);
    } finally {
      await original.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reclaims a live PID only when the Darwin provider proves a generation mismatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const ownerPid = 4_321;
    const contenderPid = 5_432;
    let ownerStartMicroseconds = "287123";
    const generationProvider = createPlatformProcessGenerationProvider({
      platform: "darwin",
      execute: async (file, args) => {
        if (file === "/usr/bin/lsappinfo") return { stdout: "" };
        if (file === "/usr/bin/python3") {
          const pid = Number(args.at(-1));
          const startMicroseconds = pid === ownerPid ? ownerStartMicroseconds : "999999";
          return { stdout: `${pid}:1785945427:${startMicroseconds}\n` };
        }
        throw new Error(`Unexpected process query: ${file}`);
      },
    });
    const original = await acquireCrashRecoverableFilesystemLock(
      lockPath,
      {},
      {
        processIdentityProvider: createProcessIdentityProvider(
          ownerPid,
          generationProvider.readProcessGeneration,
          () => "alive",
          "darwin",
        ),
      },
    );

    try {
      ownerStartMicroseconds = "287124";
      const beforeStaleLockQuarantine = vi.fn(async () => undefined);
      const replacement = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            contenderPid,
            generationProvider.readProcessGeneration,
            () => "alive",
            "darwin",
          ),
          beforeStaleLockQuarantine,
        },
      );

      expect(beforeStaleLockQuarantine).toHaveBeenCalledTimes(1);
      expect(replacement.owner).toMatchObject({
        pid: contenderPid,
        processStartIdentity: "darwin-kernel-start:1785945427:999999",
      });
      await replacement.release();
    } finally {
      await original.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries Windows generation proof within one bounded acquisition budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "missing-parent", "recovery.lock");
    const budgets: number[] = [];
    const readProcessStartIdentity = vi.fn(async (_pid: number, timeoutMs?: number) => {
      budgets.push(timeoutMs ?? 0);
      return null;
    });
    try {
      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(
              10_004,
              readProcessStartIdentity,
              () => "alive",
              "win32",
            ),
          },
        ),
      ).rejects.toThrow(/without a stable process generation/i);
      expect(readProcessStartIdentity).toHaveBeenCalledTimes(3);
      expect(budgets).toHaveLength(3);
      expect(budgets[0]).toBeLessThanOrEqual(12_000);
      expect(budgets[0]).toBeGreaterThan(0);
      expect(budgets[1]).toBeLessThan(budgets[0]!);
      expect(budgets[2]).toBeLessThan(budgets[1]!);
      await expect(stat(path.dirname(lockPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes a Windows lock only after a retry obtains stable generation proof", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    let queryAttempt = 0;
    const execute = vi.fn(
      async (_file: string, _args: string[], _options?: { timeoutMs?: number }) => {
        queryAttempt += 1;
        if (queryAttempt === 1) throw new Error("CIM startup race");
        return { stdout: "2026-08-05T12:34:56.1234567Z" };
      },
    );
    const generationProvider = createPlatformProcessGenerationProvider({
      platform: "win32",
      execute,
      windowsSystemRoot: WINDOWS_SYSTEM_ROOT,
    });
    const readProcessStartIdentity = vi.fn((pid: number, timeoutMs?: number) =>
      generationProvider.readProcessGeneration(pid, timeoutMs),
    );
    try {
      const lock = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            10_005,
            readProcessStartIdentity,
            () => "alive",
            "win32",
          ),
        },
      );
      expect(readProcessStartIdentity).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1]?.[2]?.timeoutMs).toBeLessThan(
        execute.mock.calls[0]?.[2]?.timeoutMs ?? 0,
      );
      expect(lock.owner.processStartIdentity).toBe("win32:2026-08-05T12:34:56.1234567Z");
      expect(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))).toMatchObject({
        processStartIdentity: "win32:2026-08-05T12:34:56.1234567Z",
      });
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes Windows CIM null-retry-success contenders before one reclaiming publication", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    const staleOwnerPid = 10_006;
    const deferredPid = 10_007;
    const winnerPid = 10_008;
    let resolveInitialCim!: (identity: string | null) => void;
    const initialCim = new Promise<string | null>((resolve) => {
      resolveInitialCim = resolve;
    });
    let resolveRetryCim!: (identity: string | null) => void;
    const retryCim = new Promise<string | null>((resolve) => {
      resolveRetryCim = resolve;
    });
    let markInitialCimQuery!: () => void;
    const initialCimQuery = new Promise<void>((resolve) => {
      markInitialCimQuery = resolve;
    });
    let markRetryCimQuery!: () => void;
    const retryCimQuery = new Promise<void>((resolve) => {
      markRetryCimQuery = resolve;
    });
    let markDeferredTicketPublication!: () => void;
    const deferredTicketPublished = new Promise<void>((resolve) => {
      markDeferredTicketPublication = resolve;
    });
    let deferredCimCalls = 0;
    const readDeferredCimIdentity = vi.fn((pid: number) => {
      if (pid !== deferredPid) {
        return Promise.resolve(pid === staleOwnerPid ? "reused-owner-start" : null);
      }
      deferredCimCalls += 1;
      if (deferredCimCalls === 1) {
        markInitialCimQuery();
        return initialCim;
      }
      if (deferredCimCalls === 2) {
        markRetryCimQuery();
        return retryCim;
      }
      throw new Error("Unexpected Windows CIM lookup");
    });
    let resumeWinnerReclamation!: () => void;
    const allowWinnerReclamation = new Promise<void>((resolve) => {
      resumeWinnerReclamation = resolve;
    });
    let markWinnerReclamation!: () => void;
    const winnerReadyToReclaim = new Promise<void>((resolve) => {
      markWinnerReclamation = resolve;
    });
    const winnerReclamations = vi.fn(async () => {
      markWinnerReclamation();
      await allowWinnerReclamation;
    });
    const deferredReclamations = vi.fn(async () => undefined);
    let winner: CrashRecoverableFilesystemLock | undefined;
    let winnerAcquire: Promise<CrashRecoverableFilesystemLock> | undefined;

    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          version: 1,
          pid: staleOwnerPid,
          processStartIdentity: "original-owner-start",
          ownerNonce: "original-owner",
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );

      const deferredAcquire = acquireCrashRecoverableFilesystemLock(
        lockPath,
        { timeoutMs: 10, pollMs: 10 },
        {
          processIdentityProvider: createProcessIdentityProvider(
            deferredPid,
            readDeferredCimIdentity,
            () => "alive",
            "win32",
          ),
          beforeStaleLockQuarantine: deferredReclamations,
          beforeMutationRequestTicketPublication: async () => {
            markDeferredTicketPublication();
          },
        },
      );
      void deferredAcquire.catch(() => undefined);
      await initialCimQuery;

      winnerAcquire = acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            winnerPid,
            async (pid) => (pid === staleOwnerPid ? "reused-owner-start" : "winner-start"),
            () => "alive",
            "win32",
          ),
          beforeStaleLockQuarantine: winnerReclamations,
        },
      );
      await winnerReadyToReclaim;

      resolveInitialCim(null);
      await vi.advanceTimersByTimeAsync(50);
      await retryCimQuery;
      resolveRetryCim("deferred-winner-start");

      await deferredTicketPublished;
      await vi.advanceTimersByTimeAsync(10);
      await expect(deferredAcquire).rejects.toBeInstanceOf(FilesystemLockBusyError);
      expect(deferredCimCalls).toBe(2);
      expect(winnerReclamations).toHaveBeenCalledTimes(1);
      expect(deferredReclamations).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))).toMatchObject({
        pid: staleOwnerPid,
      });

      resumeWinnerReclamation();
      winner = await winnerAcquire;
      expect(winner.owner).toMatchObject({
        pid: winnerPid,
        processStartIdentity: "winner-start",
      });
      expect(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))).toMatchObject({
        pid: winnerPid,
      });
      await winner.release();
      winner = undefined;
    } finally {
      resolveInitialCim(null);
      resolveRetryCim(null);
      resumeWinnerReclamation();
      await vi.runAllTimersAsync();
      await Promise.allSettled(
        [winnerAcquire].filter(Boolean) as Promise<CrashRecoverableFilesystemLock>[],
      );
      await winner?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
  test("reclaims a live pid whose process-start identity no longer matches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    try {
      const original = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            42_042,
            async () => "original-start",
          ),
        },
      );
      const replacement = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(43_043, async (pid) =>
            pid === 42_042 ? "reused-pid-start" : "replacement-start",
          ),
        },
      );

      const replacementOwner = await readFile(path.join(lockPath, "owner.json"), "utf8");
      await expect(original.release()).rejects.toThrow(/ownership changed/i);
      expect(await readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(replacementOwner);
      await replacement.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("does not reclaim a live owner when process-start identity lookup is ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    try {
      const original = await acquireCrashRecoverableFilesystemLock(
        lockPath,
        {},
        {
          processIdentityProvider: createProcessIdentityProvider(
            44_044,
            async () => "original-start",
          ),
        },
      );

      await expect(
        acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(45_045, async (pid) =>
              pid === 44_044 ? null : "replacement-start",
            ),
          },
        ),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      await original.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["darwin", "darwin-current-start", 70_001],
    ["linux", "linux-current-start", 70_002],
    ["win32", "win32-current-start", 70_003],
  ] as const)(
    "uses one injected %s process identity for lock ownership and mutation coordination",
    async (platform, currentStartIdentity, currentPid) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
      const lockPath = path.join(root, "recovery.lock");
      const originalPid = currentPid + 100;
      const readProcessLiveness = vi.fn((_pid: number): ProcessLiveness => "alive");
      const readProcessStartIdentity = vi.fn(async (pid: number) =>
        pid === originalPid ? "reused-original-start" : currentStartIdentity,
      );
      let mutationOwner: { pid: number; processStartIdentity: string | null } | undefined;

      try {
        await mkdir(lockPath);
        await writeFile(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({
            version: 1,
            pid: originalPid,
            processStartIdentity: "original-start",
            ownerNonce: "original-owner",
            createdAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );

        const lock = await acquireCrashRecoverableFilesystemLock(
          lockPath,
          {},
          {
            processIdentityProvider: createProcessIdentityProvider(
              currentPid,
              readProcessStartIdentity,
              readProcessLiveness,
              platform,
            ),
            beforeMutationRequestTicketPublication: async (requestPath) => {
              mutationOwner = JSON.parse(
                await readFile(path.join(requestPath, "owner.json"), "utf8"),
              ) as { pid: number; processStartIdentity: string | null };
            },
          },
        );

        expect(lock.owner).toMatchObject({
          pid: currentPid,
          processStartIdentity: currentStartIdentity,
        });
        expect(mutationOwner).toMatchObject({
          pid: currentPid,
          processStartIdentity: currentStartIdentity,
        });
        expect(readProcessLiveness).toHaveBeenCalledWith(originalPid);
        if (platform === "win32") {
          expect(readProcessStartIdentity).toHaveBeenCalledWith(currentPid, expect.any(Number));
        } else {
          expect(readProcessStartIdentity).toHaveBeenCalledWith(currentPid);
        }
        expect(readProcessStartIdentity).toHaveBeenCalledWith(originalPid);
        await lock.release();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("preserves a null-generation lock while its owner pid is alive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-filesystem-lock-"));
    const lockPath = path.join(root, "recovery.lock");
    let ownerAlive = true;
    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          version: 1,
          pid: 62_062,
          processStartIdentity: null,
          ownerNonce: "timed-out-current-owner",
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      const deps = {
        processIdentityProvider: createProcessIdentityProvider(
          63_063,
          async () => "replacement-start",
          (pid) => (pid === 62_062 && ownerAlive ? "alive" : "dead"),
        ),
      };
      await expect(
        acquireCrashRecoverableFilesystemLock(lockPath, {}, deps),
      ).rejects.toBeInstanceOf(FilesystemLockBusyError);
      ownerAlive = false;
      const replacement = await acquireCrashRecoverableFilesystemLock(lockPath, {}, deps);
      await replacement.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
