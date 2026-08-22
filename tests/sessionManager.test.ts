import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");
type SessionMetadata = Awaited<ReturnType<SessionModule["initializeSession"]>>;

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-session-tests-"));
  setOracleHomeDirOverrideForTest(oracleHomeDir);
  sessionModule = await import("../src/sessionManager.ts");
  await sessionModule.ensureSessionStorage();
});

beforeEach(async () => {
  await rm(sessionModule.getSessionsDir(), { recursive: true, force: true });
  await sessionModule.ensureSessionStorage();
  delete process.env.ORACLE_ARCHIVE_REPOSITORY;
  delete process.env.ORACLE_ARCHIVE_TOPIC;
  delete process.env.ORACLE_ARCHIVE_ACCOUNT_ALIAS;
  delete process.env.ORACLE_SESSION_ID_RECEIPT;
});

afterAll(async () => {
  await rm(oracleHomeDir, { recursive: true, force: true });
  setOracleHomeDirOverrideForTest(null);
});

describe("session storage setup", () => {
  test("ensureSessionStorage creates the sessions directory", async () => {
    await rm(sessionModule.getSessionsDir(), { recursive: true, force: true });
    await sessionModule.ensureSessionStorage();
    const stats = await stat(sessionModule.getSessionsDir());
    expect(stats.isDirectory()).toBe(true);
  });
});

describe("session identifiers", () => {
  test("createSessionId slugifies prompts without timestamps", () => {
    const id = sessionModule.createSessionId("  Hello, WORLD??? -- Example ");
    expect(id).toBe("hello-world-example");
  });

  test("createSessionId preserves whole words up to max limit", () => {
    const id = sessionModule.createSessionId("Alpha beta gamma delta epsilon zeta");
    expect(id).toBe("alpha-beta-gamma-delta-epsilon");
  });

  test("createSessionId accepts custom slugs and enforces word bounds", () => {
    const id = sessionModule.createSessionId("ignored", "Launch plan QA sync ready??");
    expect(id).toBe("launch-plan-qa-sync-ready");
    expect(() => sessionModule.createSessionId("ignored", "only two")).toThrow(/Custom slug/i);
  });

  test("createSessionId truncates overly long words to keep slugs readable", () => {
    const id = sessionModule.createSessionId("abcdefghijklm nopqrstuvwxyz shorty");
    expect(id).toBe("abcdefghij-nopqrstuvw-shorty");
  });
});

describe("session lifecycle", () => {
  test("initializeSession writes metadata, request, and log files", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-04-01T00:00:00Z"));
    const metadata = await sessionModule.initializeSession(
      {
        prompt: "Inspect code",
        model: "gpt-5.2-pro",
        file: ["notes.md"],
        previousResponseId: "resp-parent-123",
        followupSessionId: "parent-session",
        followupModel: "gpt-5.1",
        browserFollowUps: ["challenge the plan", "summarize final recommendation"],
        maxFileSizeBytes: 2_097_152,
        maxInput: 123,
        system: "SYS",
        maxOutput: 456,
        silent: false,
        filesReport: true,
        modelOverrides: {
          "gpt-5.2-pro": { apiModel: "gateway-model", reasoning: { effort: "high" } },
        },
      },
      "/tmp/cwd",
    );
    vi.useRealTimers();
    const baseDir = path.join(sessionModule.getSessionsDir(), metadata.id);
    const storedMeta = JSON.parse(await readFile(path.join(baseDir, "meta.json"), "utf8"));
    expect(storedMeta.options.file).toEqual(["notes.md"]);
    expect(storedMeta.options.maxFileSizeBytes).toBe(2_097_152);
    expect(storedMeta.options.previousResponseId).toBe("resp-parent-123");
    expect(storedMeta.options.followupSessionId).toBe("parent-session");
    expect(storedMeta.options.followupModel).toBe("gpt-5.1");
    expect(storedMeta.options.modelOverrides).toEqual({
      "gpt-5.2-pro": { apiModel: "gateway-model", reasoning: { effort: "high" } },
    });
    expect(storedMeta.options.browserFollowUps).toEqual([
      "challenge the plan",
      "summarize final recommendation",
    ]);
    await expect(readFile(path.join(baseDir, "request.json"), "utf8")).rejects.toThrow();
    const modelMeta = JSON.parse(
      await readFile(path.join(baseDir, "models", "gpt-5.2-pro.json"), "utf8"),
    );
    expect(modelMeta.status).toBe("pending");
    const perModelLog = await readFile(path.join(baseDir, "models", "gpt-5.2-pro.log"), "utf8");
    expect(perModelLog).toBe("");
    const logContent = await readFile(path.join(baseDir, "output.log"), "utf8");
    expect(logContent).toBe("");
    if (process.platform !== "win32") {
      expect((await stat(path.join(baseDir, "meta.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("persists remote browser affinity for detached workers", async () => {
    const browserConfig = {
      remoteChrome: { host: "127.0.0.1", port: 9223 },
      remoteChromeBrowserId: "browser-a",
      remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
    };
    const metadata = await sessionModule.initializeSession(
      {
        prompt: "Persist browser identity",
        model: "gpt-5.6-sol-pro",
        mode: "browser",
        browserConfig,
      },
      "/tmp/cwd",
    );
    const stored = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), metadata.id, "meta.json"), "utf8"),
    );

    expect(stored.browser?.config).toEqual(browserConfig);
    expect(stored.options?.browserConfig).toEqual(browserConfig);
  });
  test("persists a validated archive route before execution", async () => {
    process.env.ORACLE_ARCHIVE_REPOSITORY = "example-repository";
    process.env.ORACLE_ARCHIVE_TOPIC = "oracle/review/";
    process.env.ORACLE_ARCHIVE_ACCOUNT_ALIAS = "paul";
    const metadata = await sessionModule.initializeSession(
      { prompt: "Persist archive route", model: "gpt-5.6-sol-pro", mode: "browser" },
      "/tmp/cwd",
    );
    const stored = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), metadata.id, "meta.json"), "utf8"),
    );

    expect(metadata.archiveRoute).toEqual({
      repository: "example-repository",
      topic: "oracle/review",
    });
    expect(stored.archiveRoute).toEqual(metadata.archiveRoute);
    expect(metadata.archiveAccountAlias).toBe("paul");
    expect(stored.archiveAccountAlias).toBe("paul");
    expect(stored.options.archiveAccountAlias).toBeUndefined();
    expect(stored.options.archiveRoute).toBeUndefined();
  });

  test("rejects incomplete or unsafe archive metadata before reserving a session", async () => {
    process.env.ORACLE_ARCHIVE_REPOSITORY = "example-repository";
    await expect(
      sessionModule.initializeSession(
        { prompt: "Reject incomplete route", model: "gpt-5.6-sol-pro", mode: "browser" },
        "/tmp/cwd",
      ),
    ).rejects.toThrow(/archive route is invalid/i);
    process.env.ORACLE_ARCHIVE_TOPIC = "../unsafe";
    await expect(
      sessionModule.initializeSession(
        { prompt: "Reject unsafe route", model: "gpt-5.6-sol-pro", mode: "browser" },
        "/tmp/cwd",
      ),
    ).rejects.toThrow(/archive route is invalid/i);
    process.env.ORACLE_ARCHIVE_TOPIC = "oracle/review";
    process.env.ORACLE_ARCHIVE_ACCOUNT_ALIAS = "../unsafe";
    await expect(
      sessionModule.initializeSession(
        { prompt: "Reject unsafe alias", model: "gpt-5.6-sol-pro", mode: "browser" },
        "/tmp/cwd",
      ),
    ).rejects.toThrow(/archive account alias is invalid/i);
    expect(await readdir(sessionModule.getSessionsDir())).toEqual([]);
  });

  test("writes the exact collision-resolved session ID to a private receipt", async () => {
    const receiptPath = path.join(oracleHomeDir, "session-id-receipt");
    await writeFile(receiptPath, "", { mode: 0o600 });
    await sessionModule.initializeSession(
      { prompt: "ignored", slug: "Collision session proof", model: "gpt-5.6-sol-pro" },
      "/tmp/cwd",
    );
    const second = await sessionModule.initializeSession(
      { prompt: "ignored", slug: "Collision session proof", model: "gpt-5.6-sol-pro" },
      "/tmp/cwd",
    );

    if (process.platform === "win32") {
      await expect(sessionModule.writeSessionIdReceipt(second.id, receiptPath)).rejects.toThrow(
        /disabled on Windows.*ACL/i,
      );
      expect(await readFile(receiptPath, "utf8")).toBe("");
      return;
    }
    await sessionModule.writeSessionIdReceipt(second.id, receiptPath);

    expect(second.id).toBe("collision-session-proof-2");
    expect(await readFile(receiptPath, "utf8")).toBe(`${second.id}\n`);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
  });

  test("preflights a private receipt without changing its contents", async () => {
    const receiptPath = path.join(oracleHomeDir, "preflight-session-id-receipt");
    await writeFile(receiptPath, "unchanged\n", { mode: 0o600 });

    if (process.platform === "win32") {
      await expect(sessionModule.preflightSessionIdReceipt(receiptPath)).rejects.toThrow(
        /disabled on Windows.*ACL/i,
      );
    } else {
      await expect(sessionModule.preflightSessionIdReceipt(receiptPath)).resolves.toBeUndefined();
    }
    expect(await readFile(receiptPath, "utf8")).toBe("unchanged\n");
  });

  test("removes a newly reserved session when launch setup must roll back", async () => {
    const metadata = await sessionModule.initializeSession(
      { prompt: "Receipt rollback proof", model: "gpt-5.6-sol-pro" },
      "/tmp/cwd",
    );

    await sessionModule.removeSessionReservation(metadata.id);

    expect(await readdir(sessionModule.getSessionsDir())).toEqual([]);
  });

  test("leaves the receipt unchanged when Windows ACL privacy cannot be verified", async () => {
    const receiptPath = path.join(oracleHomeDir, "windows-session-id-receipt");
    await writeFile(receiptPath, "unchanged\n", { mode: 0o600 });
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await expect(
        sessionModule.writeSessionIdReceipt("session-proof", receiptPath),
      ).rejects.toThrow(/disabled on Windows.*ACL/i);
      expect(await readFile(receiptPath, "utf8")).toBe("unchanged\n");
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });

  test("rejects non-private and symlinked session ID receipts", async () => {
    if (process.platform === "win32") return;
    const publicReceipt = path.join(oracleHomeDir, "public-session-id-receipt");
    await writeFile(publicReceipt, "unchanged\n", { mode: 0o600 });
    await chmod(publicReceipt, 0o644);
    await expect(sessionModule.preflightSessionIdReceipt(publicReceipt)).rejects.toThrow(
      /private regular file/i,
    );
    await expect(
      sessionModule.writeSessionIdReceipt("session-proof", publicReceipt),
    ).rejects.toThrow(/private regular file/i);
    expect(await readFile(publicReceipt, "utf8")).toBe("unchanged\n");

    const target = path.join(oracleHomeDir, "session-id-target");
    const link = path.join(oracleHomeDir, "session-id-link");
    await writeFile(target, "unchanged\n", { mode: 0o600 });
    await symlink(target, link);
    await expect(sessionModule.writeSessionIdReceipt("session-proof", link)).rejects.toThrow(
      /private regular file/i,
    );
    expect(await readFile(target, "utf8")).toBe("unchanged\n");
  });

  test("readSessionMetadata returns null for missing sessions and updateSessionMetadata persists changes", async () => {
    expect(await sessionModule.readSessionMetadata("missing")).toBeNull();
    const meta = await sessionModule.initializeSession(
      { prompt: "Update me", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "complete",
      promptPreview: "value",
    });
    const updated = await sessionModule.readSessionMetadata(meta.id);
    expect(updated?.status).toBe("complete");
    expect(updated?.promptPreview).toBe("value");
    const sessionFiles = await readdir(path.join(sessionModule.getSessionsDir(), meta.id));
    expect(sessionFiles.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("createSessionLogWriter appends logs and supports chunk writes", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Log history", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const writer = sessionModule.createSessionLogWriter(meta.id);
    writer.logLine("First line");
    writer.writeChunk("Second chunk");
    writer.stream.end();
    await new Promise<void>((resolve) => writer.stream.once("close", () => resolve()));
    const logText = await sessionModule.readSessionLog(meta.id);
    expect(logText).toContain("First line");
    expect(logText).toContain("Second chunk");
  });

  test("createSessionLogWriter recreates missing per-model log directory", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Model log history", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    await rm(path.join(sessionModule.getSessionsDir(), meta.id, "models"), {
      recursive: true,
      force: true,
    });
    const writer = sessionModule.createSessionLogWriter(meta.id, "gemini-3-pro");
    writer.logLine("Gemini line");
    writer.stream.end();
    await new Promise<void>((resolve) => writer.stream.once("close", () => resolve()));
    const logText = await sessionModule.readModelLog(meta.id, "gemini-3-pro");
    expect(logText).toContain("Gemini line");
  });

  test("readSessionLog falls back to empty string when no log exists", async () => {
    expect(await sessionModule.readSessionLog("missing")).toBe("");
  });

  test("initializeSession appends numeric suffix when slug already exists", async () => {
    const first = await sessionModule.initializeSession(
      { prompt: "Duplicate slug please", model: "gpt-5.2-pro", slug: "alpha beta gamma" },
      "/tmp/cwd",
    );
    const second = await sessionModule.initializeSession(
      { prompt: "Duplicate slug please again", model: "gpt-5.2-pro", slug: "alpha beta gamma" },
      "/tmp/cwd",
    );
    expect(first.id).toBe("alpha-beta-gamma");
    expect(second.id).toBe("alpha-beta-gamma-2");
  });

  test("initializeSession atomically allocates unique ids under parallel same-slug creation", async () => {
    const sessions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sessionModule.initializeSession(
          {
            prompt: `Parallel slug ${index}`,
            model: "gpt-5.2-pro",
            slug: "parallel slug race",
          },
          "/tmp/cwd",
        ),
      ),
    );
    const ids = sessions.map((session) => session.id).sort();
    expect(new Set(ids).size).toBe(sessions.length);
    expect(ids).toContain("parallel-slug-race");
    expect(ids).toContain("parallel-slug-race-8");
  });

  test("initializeSession can restart from a base slug override and appends suffix on conflict", async () => {
    const first = await sessionModule.initializeSession(
      { prompt: "Original", model: "gpt-5.2-pro", slug: "alpha beta gamma" },
      "/tmp/cwd",
    );
    const restarted = await sessionModule.initializeSession(
      { prompt: "Restarted", model: "gpt-5.2-pro" },
      "/tmp/cwd",
      undefined,
      first.id,
    );
    expect(restarted.id).toBe("alpha-beta-gamma-2");
  });

  test("marks stale running sessions as zombies after 60 minutes", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Zombie", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const staleStarted = new Date(
      Date.now() - sessionModule.ZOMBIE_MAX_AGE_MS - 60_000,
    ).toISOString();
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      startedAt: staleStarted,
    });
    const listed = await sessionModule.listSessionsMetadata();
    const zombie = listed.find((m) => m.id === meta.id);
    expect(zombie?.status).toBe("error");
    expect(zombie?.errorMessage).toMatch(/zombie/i);
    const persisted = await sessionModule.readSessionMetadata(meta.id);
    expect(persisted?.status).toBe("error");
    const storedRaw = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), meta.id, "meta.json"), "utf8"),
    );
    expect(storedRaw.status).toBe("error");
    expect(storedRaw.errorMessage).toMatch(/zombie/i);
  });

  test("keeps running browser sessions when Chrome runtime is reachable", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Browser live", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          chromePid: process.pid,
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe("running");
  });

  test("keeps running browser sessions while their detached worker is alive", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Browser worker live", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      mode: "browser",
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: `oracle session ${meta.id}`,
      },
      browser: {
        runtime: {
          chromePid: 999999,
          chromePort: 1,
          chromeHost: "127.0.0.1",
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe("running");
    const listed = await sessionModule.listSessionsMetadata();
    expect(listed.find((entry) => entry.id === meta.id)?.status).toBe("running");
    const stored = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), meta.id, "meta.json"), "utf8"),
    );
    expect(stored.status).toBe("running");
  });

  test("marks running browser sessions as error when Chrome runtime is gone", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Browser dead", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          chromePid: 999999,
          chromePort: 1,
          chromeHost: "127.0.0.1",
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe("error");
    expect(refreshed?.errorMessage).toMatch(/chrome/i);
    const rawBeforeList = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), meta.id, "meta.json"), "utf8"),
    );
    expect(rawBeforeList.status).toBe("running");
    await sessionModule.listSessionsMetadata();
    const rawAfterList = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), meta.id, "meta.json"), "utf8"),
    );
    expect(rawAfterList.status).toBe("error");
    expect(rawAfterList.errorMessage).toMatch(/chrome/i);
  });
});

describe("session listing and filtering", () => {
  test("listSessionsMetadata sorts newest first and filterSessionsByRange enforces limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    await sessionModule.initializeSession(
      { prompt: "Old session", model: "gpt-5.2-pro" },
      "/tmp/a",
    );
    vi.setSystemTime(new Date("2025-01-02T12:00:00Z"));
    const recent = await sessionModule.initializeSession(
      { prompt: "Recent session", model: "gpt-5.2-pro" },
      "/tmp/b",
    );
    vi.setSystemTime(new Date("2025-01-03T00:00:00Z"));
    const metas = await sessionModule.listSessionsMetadata();
    expect(metas[0].id).toBe(recent.id);

    const rangeResult = sessionModule.filterSessionsByRange(metas, { hours: 24 });
    expect(rangeResult.entries.map((entry: SessionMetadata) => entry.id)).toEqual([recent.id]);

    const limited = sessionModule.filterSessionsByRange(metas, { includeAll: true, limit: 1 });
    expect(limited.entries).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(limited.total).toBe(2);
    vi.useRealTimers();
  });

  test("deleteSessionsOlderThan removes only sessions past the cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const oldMeta = await sessionModule.initializeSession(
      { prompt: "Old", model: "gpt-5.2-pro" },
      "/tmp/a",
    );
    vi.setSystemTime(new Date("2025-01-03T00:00:00Z"));
    const freshMeta = await sessionModule.initializeSession(
      { prompt: "Fresh", model: "gpt-5.2-pro" },
      "/tmp/b",
    );
    vi.setSystemTime(new Date("2025-01-03T12:00:00Z"));

    const result = await sessionModule.deleteSessionsOlderThan({ hours: 24 });
    expect(result).toEqual({ deleted: 1, remaining: 1 });
    expect(await sessionModule.readSessionMetadata(oldMeta.id)).toBeNull();
    expect(await sessionModule.readSessionMetadata(freshMeta.id)).not.toBeNull();
    vi.useRealTimers();
  });

  test("deleteSessionsOlderThan clears everything when includeAll is true", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Only", model: "gpt-5.2-pro" },
      "/tmp/c",
    );
    const result = await sessionModule.deleteSessionsOlderThan({ includeAll: true });
    expect(result).toEqual({ deleted: 1, remaining: 0 });
    expect(await sessionModule.readSessionMetadata(meta.id)).toBeNull();
  });
});

describe("wait helper", () => {
  test("wait resolves after the requested duration", async () => {
    vi.useFakeTimers();
    const pending = sessionModule.wait(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
