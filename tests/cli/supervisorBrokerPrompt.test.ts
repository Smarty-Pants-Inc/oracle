import { afterEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { SessionMetadata } from "../../src/sessionStore.js";
import { sessionStore } from "../../src/sessionStore.js";
import { __test__, buildSupervisorBrowserConfig } from "../../src/cli/supervisorBrokerPrompt.ts";

const SUPERVISOR_PROFILE_DIR = path.join(os.homedir(), ".oracle", "browser-profile-hidden");
const SUPERVISOR_PROJECT_URL = "https://chatgpt.com/g/g-p-69ccbf70cff08191bd2a7e61d8962644/project";
const SUPERVISOR_ORACLE_CONVERSATION_ROOT = SUPERVISOR_PROJECT_URL.replace(/\/project$/, "-oracle");

afterEach(() => {
  delete process.env.ORACLE_SUPERVISOR_THROTTLE_FILE;
  delete process.env.ORACLE_SUPERVISOR_LEASE_OWNER_ID;
});

describe("buildSupervisorBrowserConfig", () => {
  test("defaults hidden supervisor runs to a reusable manual-login profile with cookie sync", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginCookieSync: true,
      cookieSync: true,
      keepBrowser: true,
      attachRunning: false,
      desiredModel: "GPT-5.4 Pro",
      reuseChromeWaitMs: 30_000,
      assistantRecheckDelayMs: 30_000,
      assistantRecheckTimeoutMs: 300_000,
      autoReattachDelayMs: 30_000,
      autoReattachIntervalMs: 30_000,
      autoReattachTimeoutMs: 300_000,
    });
    expect(config.manualLoginProfileDir).toBe(SUPERVISOR_PROFILE_DIR);
  });

  test("respects an explicit opt-out from manual-login cookie sync", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          manualLoginCookieSync: false,
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginCookieSync: false,
      cookieSync: false,
      keepBrowser: true,
    });
  });

  test("pins supervisor runs to the dedicated hidden profile", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          manualLogin: false,
          manualLoginProfileDir: "/tmp/oracle-supervisor-profile",
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config.manualLoginProfileDir).toBe(SUPERVISOR_PROFILE_DIR);
  });

  test("ignores profile overrides so supervisor cannot drift onto another Chrome profile", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          manualLoginProfileDir: "/tmp/oracle-supervisor-profile",
        },
      },
      env: {
        ORACLE_BROWSER_PROFILE_DIR: "/tmp/oracle-hidden-profile",
      },
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config.manualLoginProfileDir).toBe(SUPERVISOR_PROFILE_DIR);
  });

  test("does not force local macOS cookie-sync defaults onto remote browser hosts", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: false,
      useDedicatedHiddenProfile: false,
    });

    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginCookieSync: false,
      cookieSync: false,
      keepBrowser: true,
      autoReattachIntervalMs: 30_000,
    });
    expect(config.manualLoginProfileDir).toBeNull();
  });

  test("ignores configured attach-running browser reuse for supervisor runs", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          attachRunning: true,
          manualLoginProfileDir: "/tmp/oracle-supervisor-profile",
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config).toMatchObject({
      launcher: "chrome",
      attachRunning: false,
      manualLogin: true,
      manualLoginProfileDir: SUPERVISOR_PROFILE_DIR,
      manualLoginCookieSync: true,
      cookieSync: true,
      keepBrowser: true,
    });
  });

  test("forces supervisor runs back onto hidden Chrome even when carbonyl is configured", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          launcher: "carbonyl",
          manualLoginProfileDir: "/tmp/oracle-supervisor-profile",
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config).toMatchObject({
      launcher: "chrome",
      manualLogin: true,
      manualLoginCookieSync: true,
      manualLoginProfileDir: SUPERVISOR_PROFILE_DIR,
      cookieSync: true,
      keepBrowser: true,
      attachRunning: false,
    });
  });

  test("pins supervisor runs to a dedicated project URL instead of the ChatGPT root", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          chatgptUrl: "https://chatgpt.com/",
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      supervisorChatgptUrl: SUPERVISOR_PROJECT_URL,
      defaultManualLoginCookieSync: true,
    });

    expect(config.chatgptUrl).toBe(SUPERVISOR_PROJECT_URL);
    expect(config.url).toBe(SUPERVISOR_PROJECT_URL);
  });

  test("honors an explicit supervisor thinking-time override", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          thinkingTime: "standard",
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      browserThinkingTime: "extended",
      defaultManualLoginCookieSync: true,
    });

    expect(config.thinkingTime).toBe("extended");
  });

  test("uses a distinct throttle scope for remote supervisor brokers", () => {
    const localConfig = buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });
    const remoteConfig = buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      supervisorThrottleScope: "remote:oracle.example.test",
      defaultManualLoginCookieSync: false,
      useDedicatedHiddenProfile: false,
    });

    expect(__test__.supervisorBrowserThrottleProfileKey(localConfig)).toBe(SUPERVISOR_PROFILE_DIR);
    expect(__test__.supervisorBrowserThrottleProfileKey(remoteConfig)).toBe(
      "scope:remote:oracle.example.test",
    );
  });
});

describe("resolveSupervisorChatgptUrl", () => {
  test("prefers an explicit supervisor project override", async () => {
    const url = await __test__.resolveSupervisorChatgptUrl({
      userConfig: {
        browser: {
          supervisorChatgptUrl: SUPERVISOR_PROJECT_URL,
          chatgptUrl: "https://chatgpt.com/",
        },
      },
      env: {},
    });

    expect(url).toBe(SUPERVISOR_PROJECT_URL);
  });

  test("rejects an explicit supervisor root override", async () => {
    await expect(
      __test__.resolveSupervisorChatgptUrl({
        userConfig: {
          browser: {
            supervisorChatgptUrl: "https://chatgpt.com/",
            chatgptUrl: SUPERVISOR_PROJECT_URL,
          },
        },
        env: {},
      }),
    ).rejects.toThrow(/project-scoped ChatGPT URL/i);
  });

  test("accepts a project-scoped browser url from config", async () => {
    const url = await __test__.resolveSupervisorChatgptUrl({
      userConfig: {
        browser: {
          chatgptUrl: SUPERVISOR_PROJECT_URL,
        },
      },
      env: {},
    });

    expect(url).toBe(SUPERVISOR_PROJECT_URL);
  });

  test("rejects supervisor runs when a root browser url is configured", async () => {
    await expect(
      __test__.resolveSupervisorChatgptUrl({
        userConfig: {
          browser: {
            chatgptUrl: "https://chatgpt.com/",
          },
        },
        env: {},
      }),
    ).rejects.toThrow(/project-scoped ChatGPT URL/i);
  });

  test("rejects supervisor runs when no project-scoped URL is configured", async () => {
    await expect(
      __test__.resolveSupervisorChatgptUrl({
        userConfig: {},
        env: {},
      }),
    ).rejects.toThrow(/project-scoped ChatGPT URL/i);
  });
});

describe("supervisor prompt replay safety", () => {
  function makeBrowserConfig() {
    return buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4",
      inputModel: "gpt-5.4",
      supervisorChatgptUrl: SUPERVISOR_PROJECT_URL,
      defaultManualLoginCookieSync: true,
    });
  }

  function makeReplayRequest() {
    return {
      prompt: "Reply with exactly READY.",
      sessionSlug: "codex-oracle-replay",
      model: "gpt-5.4",
      followupSession: "parent-session",
      cwd: "/tmp/project-a",
      files: ["src/a.ts", "src/b.ts"],
    };
  }

  function makeReplaySession(
    overrides: Partial<SessionMetadata> & {
      id?: string;
      status?: string;
      assistantOutput?: string;
      chatgptUrl?: string;
      followupSessionId?: string;
      cwd?: string;
      files?: string[];
      thinkingTime?: "light" | "standard" | "extended" | "heavy";
    } = {},
  ): SessionMetadata {
    const sessionId = overrides.id ?? "codex-oracle-replay";
    const status = overrides.status ?? "completed";
    const model = overrides.model ?? "gpt-5.4";
    return {
      id: sessionId,
      createdAt: overrides.createdAt ?? "2026-04-06T12:00:00.000Z",
      status,
      cwd: overrides.cwd ?? "/tmp/project-a",
      mode: "browser",
      model,
      browser: {
        config: {
          manualLoginProfileDir: SUPERVISOR_PROFILE_DIR,
          chatgptUrl: overrides.chatgptUrl ?? SUPERVISOR_PROJECT_URL,
          thinkingTime: overrides.thinkingTime,
        },
      },
      response: {
        status,
        assistantOutput: overrides.assistantOutput ?? "READY",
      },
      options: {
        prompt: "Reply with exactly READY.",
        file: overrides.files ?? ["src/a.ts", "src/b.ts"],
        model,
        effectiveModelId: model,
        followupSessionId: overrides.followupSessionId ?? "parent-session",
        mode: "browser",
      },
      ...overrides,
    };
  }

  test("reuses the newest matching completed broker session", () => {
    const browserConfig = makeBrowserConfig();
    const request = makeReplayRequest();
    const picked = __test__.pickReusableSupervisorPromptSession(
      [
        makeReplaySession({
          id: "codex-oracle-replay-2",
          createdAt: "2026-04-06T11:00:00.000Z",
          assistantOutput: "OLDER",
        }),
        makeReplaySession({
          id: "codex-oracle-replay-3",
          createdAt: "2026-04-06T13:00:00.000Z",
          assistantOutput: "NEWEST",
        }),
        makeReplaySession({
          id: "codex-oracle-replay-4",
          createdAt: "2026-04-06T14:00:00.000Z",
          assistantOutput: "WRONG",
          chatgptUrl: "https://chatgpt.com/g/g-other/project",
        }),
      ],
      request,
      "gpt-5.4",
      browserConfig,
    );

    expect(picked?.id).toBe("codex-oracle-replay-3");
  });

  test("does not reuse a broker session when cwd or files differ", () => {
    const browserConfig = makeBrowserConfig();
    const request = makeReplayRequest();

    expect(
      __test__.pickReusableSupervisorPromptSession(
        [makeReplaySession({ cwd: "/tmp/project-b" })],
        request,
        "gpt-5.4",
        browserConfig,
      ),
    ).toBeNull();

    expect(
      __test__.pickReusableSupervisorPromptSession(
        [makeReplaySession({ files: ["src/a.ts", "src/c.ts"] })],
        request,
        "gpt-5.4",
        browserConfig,
      ),
    ).toBeNull();
  });

  test("does not reuse a broker session when supervisor thread url or project scope differs", () => {
    const browserConfig = makeBrowserConfig();
    const request = makeReplayRequest();
    const expectedSupervisorThread = {
      conversationId: "thread-123",
      url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/thread-123`,
      projectUrl: SUPERVISOR_PROJECT_URL,
      verifiedAt: "2026-04-06T12:00:00.000Z",
    };

    expect(
      __test__.pickReusableSupervisorPromptSession(
        [
          makeReplaySession({
            supervisorThread: {
              ...expectedSupervisorThread,
              url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/thread-999`,
            },
          }),
        ],
        request,
        "gpt-5.4",
        browserConfig,
        expectedSupervisorThread,
      ),
    ).toBeNull();

    expect(
      __test__.pickReusableSupervisorPromptSession(
        [
          makeReplaySession({
            supervisorThread: {
              ...expectedSupervisorThread,
              projectUrl: "https://chatgpt.com/g/g-other/project",
            },
          }),
        ],
        request,
        "gpt-5.4",
        browserConfig,
        expectedSupervisorThread,
      ),
    ).toBeNull();

    const picked = __test__.pickReusableSupervisorPromptSession(
      [
        makeReplaySession({
          supervisorThread: expectedSupervisorThread,
        }),
      ],
      request,
      "gpt-5.4",
      browserConfig,
      expectedSupervisorThread,
    );

    expect(picked?.id).toBe("codex-oracle-replay");
  });

  test("does not reuse a broker session when runtime metadata contradicts the expected supervisor thread", () => {
    const browserConfig = makeBrowserConfig();
    const request = makeReplayRequest();
    const expectedSupervisorThread = {
      conversationId: "thread-123",
      url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/thread-123`,
      projectUrl: SUPERVISOR_PROJECT_URL,
      verifiedAt: "2026-04-06T12:00:00.000Z",
    };

    expect(
      __test__.pickReusableSupervisorPromptSession(
        [
          makeReplaySession({
            supervisorThread: expectedSupervisorThread,
            browser: {
              config: {
                manualLoginProfileDir: SUPERVISOR_PROFILE_DIR,
                chatgptUrl: SUPERVISOR_PROJECT_URL,
              },
              runtime: {
                conversationId: "wrong-thread",
              },
            },
          }),
        ],
        request,
        "gpt-5.4",
        browserConfig,
        expectedSupervisorThread,
      ),
    ).toBeNull();

    expect(
      __test__.pickReusableSupervisorPromptSession(
        [
          makeReplaySession({
            supervisorThread: expectedSupervisorThread,
            browser: {
              config: {
                manualLoginProfileDir: SUPERVISOR_PROFILE_DIR,
                chatgptUrl: SUPERVISOR_PROJECT_URL,
              },
              runtime: {
                tabUrl: "https://chatgpt.com/g/g-other/c/thread-123",
              },
            },
          }),
        ],
        request,
        "gpt-5.4",
        browserConfig,
        expectedSupervisorThread,
      ),
    ).toBeNull();
  });

  test("does not reuse a broker session when thinking time differs", () => {
    const browserConfig = buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      browserThinkingTime: "extended",
      supervisorChatgptUrl: SUPERVISOR_PROJECT_URL,
      defaultManualLoginCookieSync: true,
    });
    const request = {
      ...makeReplayRequest(),
      model: "gpt-5.4-pro",
      browserThinkingTime: "extended" as const,
    };

    expect(
      __test__.pickReusableSupervisorPromptSession(
        [makeReplaySession({ model: "gpt-5.4-pro", thinkingTime: "standard" })],
        request,
        "gpt-5.4-pro",
        browserConfig,
      ),
    ).toBeNull();
  });

  test("does not reuse a broker session when the remote throttle scope differs", () => {
    const browserConfig = buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      supervisorThrottleScope: "remote:host-b",
      supervisorChatgptUrl: SUPERVISOR_PROJECT_URL,
      defaultManualLoginCookieSync: false,
      useDedicatedHiddenProfile: false,
    });

    expect(
      __test__.pickReusableSupervisorPromptSession(
        [
          makeReplaySession({
            model: "gpt-5.4-pro",
            browser: {
              config: {
                manualLoginProfileDir: null,
                chatgptUrl: SUPERVISOR_PROJECT_URL,
                supervisorThrottleScope: "remote:host-a",
              },
            },
            options: {
              prompt: "Reply with exactly READY.",
              file: ["src/a.ts", "src/b.ts"],
              model: "gpt-5.4-pro",
              effectiveModelId: "gpt-5.4-pro",
              followupSessionId: "parent-session",
              mode: "browser",
              browserConfig: {
                supervisorThrottleScope: "remote:host-a",
              },
            },
          }),
        ],
        {
          ...makeReplayRequest(),
          model: "gpt-5.4-pro",
        },
        "gpt-5.4-pro",
        browserConfig,
      ),
    ).toBeNull();
  });

  test("does not reuse a slug-prefix collision from another session family", () => {
    const browserConfig = makeBrowserConfig();
    const request = { ...makeReplayRequest(), sessionSlug: "oracle" };

    const picked = __test__.pickReusableSupervisorPromptSession(
      [
        makeReplaySession({
          id: "oracle-review",
          promptPreview: "Reply with exactly READY.",
        }),
      ],
      request,
      "gpt-5.4",
      browserConfig,
    );

    expect(picked).toBeNull();
  });

  test("returns a completed replay response without starting a duplicate turn", async () => {
    const listSessionsSpy = vi
      .spyOn(sessionStore, "listSessions")
      .mockResolvedValue([makeReplaySession({ assistantOutput: "READY" })]);

    try {
      await expect(
        __test__.findReusableSupervisorPromptResponse(
          makeReplayRequest(),
          "gpt-5.4",
          makeBrowserConfig(),
        ),
      ).resolves.toEqual({
        ok: true,
        sessionId: "codex-oracle-replay",
        output: "READY",
      });
    } finally {
      listSessionsSpy.mockRestore();
    }
  });

  test("returns the existing running session instead of spawning a duplicate turn", async () => {
    const listSessionsSpy = vi.spyOn(sessionStore, "listSessions").mockResolvedValue([
      makeReplaySession({
        status: "running",
        assistantOutput: "",
      }),
    ]);

    try {
      await expect(
        __test__.findReusableSupervisorPromptResponse(
          makeReplayRequest(),
          "gpt-5.4",
          makeBrowserConfig(),
        ),
      ).resolves.toEqual({
        ok: false,
        sessionId: "codex-oracle-replay",
        error:
          "Session codex-oracle-replay is already running. Reattach later with: oracle session codex-oracle-replay",
      });
    } finally {
      listSessionsSpy.mockRestore();
    }
  });

  test("reuses a manually reattached completed session by recovering output from the log", async () => {
    const listSessionsSpy = vi.spyOn(sessionStore, "listSessions").mockResolvedValue([
      makeReplaySession({
        assistantOutput: "",
      }),
    ]);
    const readLogSpy = vi
      .spyOn(sessionStore, "readLog")
      .mockResolvedValue(
        "[reattach] captured assistant response from existing Chrome tab\nAnswer:\nREADY FROM LOG\n",
      );

    try {
      await expect(
        __test__.findReusableSupervisorPromptResponse(
          makeReplayRequest(),
          "gpt-5.4",
          makeBrowserConfig(),
        ),
      ).resolves.toEqual({
        ok: true,
        sessionId: "codex-oracle-replay",
        output: "READY FROM LOG",
      });
    } finally {
      readLogSpy.mockRestore();
      listSessionsSpy.mockRestore();
    }
  });
});

describe("supervisor browser throttling", () => {
  test("honors the supervisor throttle file override env var", () => {
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = "/tmp/oracle-supervisor-throttle-test.json";

    expect(__test__.resolveSupervisorBrowserThrottleFile()).toBe(
      "/tmp/oracle-supervisor-throttle-test.json",
    );
    expect(__test__.resolveSupervisorBrowserThrottleLockFile()).toBe(
      "/tmp/oracle-supervisor-throttle-test.json.lock",
    );
  });

  test("serializes throttle state updates behind a lock file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");

    const first = await __test__.acquireSupervisorBrowserThrottleLock();
    let acquired = false;
    const pending = __test__.acquireSupervisorBrowserThrottleLock().then(async (second) => {
      acquired = true;
      await fs.rm(second.lockPath, { force: true });
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(acquired).toBe(false);

    await fs.rm(first.lockPath, { force: true });
    await pending;
    expect(acquired).toBe(true);
  });

  test("clears a stale dead throttle lock before waiting", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");
    const lockPath = __test__.resolveSupervisorBrowserThrottleLockFile();
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 999_999,
        lockId: "stale-lock",
        createdAt: new Date(Date.now() - 30_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
      "utf8",
    );

    const lock = await __test__.acquireSupervisorBrowserThrottleLock();

    expect(lock.lockPath).toBe(lockPath);
    await fs.rm(lock.lockPath, { force: true });
  });

  test("clears an expired throttle lock even if the original pid is still alive", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");
    const lockPath = __test__.resolveSupervisorBrowserThrottleLockFile();
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        lockId: "expired-lock",
        createdAt: new Date(Date.now() - 30_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
      "utf8",
    );

    const lock = await __test__.acquireSupervisorBrowserThrottleLock();

    expect(lock.lockPath).toBe(lockPath);
    await fs.rm(lock.lockPath, { force: true });
  });

  test("clears a stale throttle lock when the pid was reused with a different start marker", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");
    const lockPath = __test__.resolveSupervisorBrowserThrottleLockFile();
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        lockId: "stale-reused-pid-lock",
        createdAt: new Date(Date.now() - 5_000).toISOString(),
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
        processStartMarker: "old-process-start",
      }),
      "utf8",
    );

    const lock = await __test__.acquireSupervisorBrowserThrottleLock();
    const written = JSON.parse(await fs.readFile(lockPath, "utf8")) as { lockId?: string };

    expect(lock.lockPath).toBe(lockPath);
    expect(written.lockId).not.toBe("stale-reused-pid-lock");
    await fs.rm(lock.lockPath, { force: true });
  });

  test("enforces a short minimum gap between requests", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 0, 30);
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        requestStartedAt: [new Date(nowMs - 5_000).toISOString()],
      },
      "gpt-5.4-pro",
      nowMs,
    );

    expect(decision.reason).toBe("min-gap");
    expect(decision.delayMs).toBeGreaterThan(20_000);
  });

  test("allows a realistic multi-turn pro workflow before window throttling", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 20, 0);
    const recent = [
      nowMs - 20 * 60_000,
      nowMs - 15 * 60_000,
      nowMs - 10 * 60_000,
      nowMs - 5 * 60_000,
      nowMs - 2 * 60_000,
    ].map((timestamp) => new Date(timestamp).toISOString());
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        requestStartedAt: recent,
      },
      "gpt-5.4-pro",
      nowMs,
    );

    expect(decision.reason).toBe(null);
    expect(decision.delayMs).toBe(0);
  });

  test("allows sustained same-profile traffic well past six requests before window throttling", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 29, 0);
    const recent = Array.from({ length: 12 }, (_, index) =>
      new Date(nowMs - (29 - index * 2) * 60_000).toISOString(),
    );
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        requestStartedAt: recent,
      },
      "gpt-5.4-pro",
      nowMs,
    );

    expect(decision.reason).toBe(null);
    expect(decision.delayMs).toBe(0);
  });

  test("throttles pro requests after the twenty-fourth request in the rolling window", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 20, 0);
    const recent = Array.from({ length: 24 }, (_, index) =>
      new Date(nowMs - (24 - index) * 60_000).toISOString(),
    );
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        requestStartedAt: recent,
      },
      "gpt-5.4-pro",
      nowMs,
    );

    expect(decision.reason).toBe("window-budget");
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  test("respects an explicit rate-limit cooldown before allowing another request", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 0, 0);
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        cooldownUntil: new Date(nowMs + 90_000).toISOString(),
      },
      "gpt-5.4",
      nowMs,
    );

    expect(decision.reason).toBe("rate-limit-cooldown");
    expect(decision.delayMs).toBeGreaterThanOrEqual(90_000);
  });

  test("ignores a stale dead lease during startup sanitation", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 0, 0);
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        activeLease: {
          ownerId: "dead-owner",
          pid: 999_999,
          hostname: "test-host",
          acquiredAt: new Date(nowMs - 60_000).toISOString(),
          expiresAt: new Date(nowMs + 60_000).toISOString(),
        },
      },
      "gpt-5.4",
      nowMs,
      { isProcessAliveFn: () => false, ownerId: "current-owner" },
    );

    expect(decision.reason).toBeNull();
    expect(decision.delayMs).toBe(0);
  });

  test("ignores a reused pid when the process start marker no longer matches", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 0, 0);
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        activeLease: {
          ownerId: "stale-owner",
          pid: process.pid,
          hostname: "test-host",
          acquiredAt: new Date(nowMs - 60_000).toISOString(),
          expiresAt: new Date(nowMs + 60_000).toISOString(),
          processStartMarker: "old-process-start",
        },
      },
      "gpt-5.4",
      nowMs,
      {
        isProcessAliveFn: () => true,
        readProcessStartMarkerFn: () => "new-process-start",
        ownerId: "current-owner",
      },
    );

    expect(decision.reason).toBeNull();
    expect(decision.delayMs).toBe(0);
  });

  test("waits behind a live competing lease", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 0, 0);
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        activeLease: {
          ownerId: "other-owner",
          pid: process.pid,
          hostname: "test-host",
          acquiredAt: new Date(nowMs - 1_000).toISOString(),
          expiresAt: new Date(nowMs + 45_000).toISOString(),
        },
      },
      "gpt-5.4",
      nowMs,
      { isProcessAliveFn: () => true, ownerId: "current-owner" },
    );

    expect(decision.reason).toBe("active-lease");
    expect(decision.delayMs).toBeGreaterThan(40_000);
  });

  test("waits behind a live lease even when the owner id is reused by a different process", () => {
    const nowMs = Date.UTC(2026, 3, 5, 12, 0, 0);
    const decision = __test__.computeSupervisorBrowserThrottleDecision(
      {
        activeLease: {
          ownerId: "shared-owner",
          pid: 40_517,
          hostname: "test-host",
          acquiredAt: new Date(nowMs - 1_000).toISOString(),
          expiresAt: new Date(nowMs + 45_000).toISOString(),
          processStartMarker: "old-process-start",
        },
      },
      "gpt-5.4",
      nowMs,
      {
        ownerId: "shared-owner",
        ownerPid: 51_234,
        ownerProcessStartMarker: "new-process-start",
        isProcessAliveFn: () => true,
        readProcessStartMarkerFn: () => "old-process-start",
      },
    );

    expect(decision.reason).toBe("active-lease");
    expect(decision.delayMs).toBeGreaterThan(40_000);
  });

  test("lease heartbeat extends an owned reservation without changing request history", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");
    const throttleFile = __test__.resolveSupervisorBrowserThrottleFile();
    const requestStartedAt = new Date(Date.now() - 10_000).toISOString();
    const oldExpiresAt = new Date(Date.now() + 5_000).toISOString();
    await fs.writeFile(
      throttleFile,
      JSON.stringify({
        profiles: {
          [SUPERVISOR_PROFILE_DIR]: {
            requestStartedAt: [requestStartedAt],
            activeLease: {
              ownerId: "heartbeat-owner",
              pid: process.pid,
              hostname: "test-host",
              acquiredAt: "2026-04-05T12:00:01.000Z",
              expiresAt: oldExpiresAt,
            },
          },
        },
      }),
      "utf8",
    );

    await __test__.heartbeatSupervisorBrowserRequestSlot({
      profileKey: SUPERVISOR_PROFILE_DIR,
      ownerId: "heartbeat-owner",
    });

    const state = JSON.parse(await fs.readFile(throttleFile, "utf8")) as {
      profiles: Record<
        string,
        {
          requestStartedAt?: string[];
          activeLease?: { expiresAt?: string };
        }
      >;
    };
    expect(state.profiles[SUPERVISOR_PROFILE_DIR]?.requestStartedAt).toEqual([requestStartedAt]);
    expect(
      Date.parse(state.profiles[SUPERVISOR_PROFILE_DIR]?.activeLease?.expiresAt ?? ""),
    ).toBeGreaterThan(Date.parse(oldExpiresAt));
  });

  test("lease heartbeat fails closed once ownership is lost", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");
    const throttleFile = __test__.resolveSupervisorBrowserThrottleFile();
    await fs.writeFile(
      throttleFile,
      JSON.stringify({
        profiles: {
          [SUPERVISOR_PROFILE_DIR]: {
            activeLease: {
              ownerId: "other-owner",
              pid: process.pid,
              hostname: "test-host",
              acquiredAt: "2026-04-05T12:00:01.000Z",
              expiresAt: new Date(Date.now() + 5_000).toISOString(),
            },
          },
        },
      }),
      "utf8",
    );

    await expect(
      __test__.heartbeatSupervisorBrowserRequestSlot({
        profileKey: SUPERVISOR_PROFILE_DIR,
        ownerId: "heartbeat-owner",
      }),
    ).rejects.toThrow(/ownership was lost/i);
  });

  test("runtime attach lease waits for a competing hidden lease instead of failing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");
    const throttleFile = __test__.resolveSupervisorBrowserThrottleFile();
    await fs.writeFile(
      throttleFile,
      JSON.stringify({
        profiles: {
          [SUPERVISOR_PROFILE_DIR]: {
            activeLease: {
              ownerId: "other-owner",
              pid: process.pid,
              hostname: "test-host",
              acquiredAt: "2026-04-05T12:00:01.000Z",
              expiresAt: new Date(Date.now() + 50).toISOString(),
            },
          },
        },
      }),
      "utf8",
    );

    const log = vi.fn();
    const startedAt = Date.now();
    const reservation = await __test__.reserveSupervisorRuntimeAttachLease(log);
    const elapsedMs = Date.now() - startedAt;
    const state = JSON.parse(await fs.readFile(throttleFile, "utf8")) as {
      profiles?: Record<string, { activeLease?: { ownerId?: string; pid?: number } }>;
    };

    expect(elapsedMs).toBeGreaterThanOrEqual(25);
    expect(log).toHaveBeenCalled();
    expect(state.profiles?.[SUPERVISOR_PROFILE_DIR]?.activeLease?.ownerId).toBe(
      reservation.ownerId,
    );
    expect(state.profiles?.[SUPERVISOR_PROFILE_DIR]?.activeLease?.pid).toBe(process.pid);

    await __test__.releaseSupervisorBrowserRequestSlot(reservation);
  });

  test("rate-limit cooldown preserves an owned active lease instead of clobbering it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");
    const throttleFile = __test__.resolveSupervisorBrowserThrottleFile();
    await fs.writeFile(
      throttleFile,
      JSON.stringify({
        profiles: {
          [SUPERVISOR_PROFILE_DIR]: {
            requestStartedAt: [new Date(Date.now() - 10_000).toISOString()],
            activeLease: {
              ownerId: "lease-owner",
              pid: process.pid,
              hostname: "test-host",
              acquiredAt: "2026-04-05T12:00:01.000Z",
              expiresAt: new Date(Date.now() + 5_000).toISOString(),
            },
          },
        },
      }),
      "utf8",
    );

    await __test__.markSupervisorBrowserRateLimit(
      {
        manualLoginProfileDir: SUPERVISOR_PROFILE_DIR,
      },
      {
        profileKey: SUPERVISOR_PROFILE_DIR,
        ownerId: "lease-owner",
      },
      vi.fn(),
    );

    const state = JSON.parse(await fs.readFile(throttleFile, "utf8")) as {
      profiles: Record<
        string,
        {
          requestStartedAt?: string[];
          cooldownUntil?: string;
          activeLease?: { ownerId?: string };
        }
      >;
    };
    expect(state.profiles[SUPERVISOR_PROFILE_DIR]?.requestStartedAt).toHaveLength(1);
    expect(state.profiles[SUPERVISOR_PROFILE_DIR]?.cooldownUntil).toBeTruthy();
    expect(state.profiles[SUPERVISOR_PROFILE_DIR]?.activeLease?.ownerId).toBe("lease-owner");
  });

  test("signal cleanup releases an owned active lease before broker exit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-throttle-"));
    process.env.ORACLE_SUPERVISOR_THROTTLE_FILE = path.join(tempDir, "throttle.json");
    const throttleFile = __test__.resolveSupervisorBrowserThrottleFile();
    await fs.writeFile(
      throttleFile,
      JSON.stringify({
        profiles: {
          [SUPERVISOR_PROFILE_DIR]: {
            requestStartedAt: [new Date(Date.now() - 5_000).toISOString()],
            activeLease: {
              ownerId: "cleanup-owner",
              pid: process.pid,
              hostname: "test-host",
              acquiredAt: "2026-04-05T12:00:01.000Z",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        },
      }),
      "utf8",
    );

    const processLike = new EventEmitter() as unknown as Pick<NodeJS.Process, "on" | "off"> & {
      emit: (event: string) => boolean;
    };
    const exitFn = vi.fn();
    const cleanup = __test__.installSupervisorBrowserRequestSlotSignalCleanup(
      {
        profileKey: SUPERVISOR_PROFILE_DIR,
        ownerId: "cleanup-owner",
        ownerPid: process.pid,
        requestStartedAtMs: Date.now(),
      },
      __test__.releaseSupervisorBrowserRequestSlot,
      processLike,
      exitFn,
    );

    processLike.emit("SIGTERM");
    await cleanup.waitForCleanup();

    const state = JSON.parse(await fs.readFile(throttleFile, "utf8")) as {
      profiles?: Record<string, { activeLease?: { ownerId?: string } }>;
    };
    expect(state.profiles?.[SUPERVISOR_PROFILE_DIR]?.activeLease ?? null).toBeNull();
    expect(exitFn).toHaveBeenCalledWith(143);
  });
});

describe("supervisor prompt completion", () => {
  test("rejects incomplete sessions instead of returning empty success", () => {
    expect(
      __test__.finalizeSupervisorPromptOperationResult(
        "sess-123",
        "running",
        "assistant-timeout",
        "",
      ),
    ).toEqual({
      ok: false,
      sessionId: "sess-123",
      error:
        "Session sess-123 did not complete (assistant-timeout). Reattach later with: oracle session sess-123",
    });
  });

  test("rejects completed sessions with no assistant output", () => {
    expect(
      __test__.finalizeSupervisorPromptOperationResult("sess-123", "completed", null, "  "),
    ).toEqual({
      ok: false,
      sessionId: "sess-123",
      error: "Session sess-123 completed without assistant output.",
    });
  });

  test("returns completed output once the session finishes even if the run promise stalls", async () => {
    vi.useFakeTimers();
    try {
      const readSession = vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({ status: "completed", response: { incompleteReason: null } });
      const readOutput = vi
        .fn()
        .mockResolvedValueOnce("")
        .mockResolvedValue("F_1775453261 oracle-orch-e2e-1.txt oracle-orch-e2e-2.txt\n");

      const pending = __test__.waitForSupervisorPromptRunOutcome({
        sessionId: "sess-123",
        outputPath: "/tmp/out.md",
        run: new Promise<void>(() => {}),
        readSession,
        readOutput,
        pollIntervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_100);

      await expect(pending).resolves.toEqual({
        kind: "session-completed",
        snapshot: {
          sessionStatus: "completed",
          incompleteReason: null,
          output: "F_1775453261 oracle-orch-e2e-1.txt oracle-orch-e2e-2.txt",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits briefly for the run promise to settle after the session completes", async () => {
    vi.useFakeTimers();
    try {
      const readSession = vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({ status: "completed", response: { incompleteReason: null } });
      const readOutput = vi.fn().mockResolvedValue("settled output");
      const pending = __test__.waitForSupervisorPromptRunOutcome({
        sessionId: "sess-grace",
        outputPath: "/tmp/out.md",
        run: new Promise<void>((resolve) => {
          setTimeout(resolve, 1_400);
        }),
        readSession,
        readOutput,
        pollIntervalMs: 1_000,
        runSettleGraceMs: 1_000,
      });

      let resolved = false;
      void pending.then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(1_100);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(400);

      await expect(pending).resolves.toEqual({ kind: "run-finished" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns run-still-pending once the run-settle grace expires", async () => {
    vi.useFakeTimers();
    try {
      const readSession = vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({ status: "completed", response: { incompleteReason: null } });
      const readOutput = vi.fn().mockResolvedValue("completed output");
      const pending = __test__.waitForSupervisorPromptRunOutcome({
        sessionId: "sess-grace-timeout",
        outputPath: "/tmp/out.md",
        run: new Promise<void>(() => {}),
        readSession,
        readOutput,
        pollIntervalMs: 1_000,
        runSettleGraceMs: 500,
      });

      await vi.advanceTimersByTimeAsync(1_600);

      await expect(pending).resolves.toEqual({
        kind: "run-still-pending",
        snapshot: {
          sessionStatus: "completed",
          incompleteReason: null,
          output: "completed output",
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns session-completed once the session finishes even if the output is empty", async () => {
    vi.useFakeTimers();
    try {
      const readSession = vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({ status: "completed", response: { incompleteReason: null } });
      const readOutput = vi.fn().mockResolvedValue("");

      const pending = __test__.waitForSupervisorPromptRunOutcome({
        sessionId: "sess-blank",
        outputPath: "/tmp/out.md",
        run: new Promise<void>(() => {}),
        readSession,
        readOutput,
        pollIntervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_100);

      await expect(pending).resolves.toEqual({
        kind: "session-completed",
        snapshot: {
          sessionStatus: "completed",
          incompleteReason: null,
          output: "",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns a terminal snapshot when the session errors before the run promise resolves", async () => {
    vi.useFakeTimers();
    try {
      const readSession = vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({
          status: "error",
          response: { incompleteReason: "chrome-disconnected" },
        });
      const readOutput = vi.fn().mockResolvedValue("");

      const pending = __test__.waitForSupervisorPromptRunOutcome({
        sessionId: "sess-error",
        outputPath: "/tmp/out.md",
        run: new Promise<void>(() => {}),
        readSession,
        readOutput,
        pollIntervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_100);

      await expect(pending).resolves.toEqual({
        kind: "session-terminal",
        snapshot: {
          sessionStatus: "error",
          incompleteReason: "chrome-disconnected",
          output: "",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("falls back to persisted assistant output when the temp output file is blank", async () => {
    vi.useFakeTimers();
    try {
      const readSession = vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValue({
          status: "completed",
          response: {
            incompleteReason: null,
            assistantOutput: "persisted oracle answer",
          },
        });
      const readOutput = vi.fn().mockResolvedValue("");

      const pending = __test__.waitForSupervisorPromptRunOutcome({
        sessionId: "sess-persisted",
        outputPath: "/tmp/out.md",
        run: new Promise<void>(() => {}),
        readSession,
        readOutput,
        pollIntervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_100);

      await expect(pending).resolves.toEqual({
        kind: "session-completed",
        snapshot: {
          sessionStatus: "completed",
          incompleteReason: null,
          output: "persisted oracle answer",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops polling once the run promise wins the race", async () => {
    vi.useFakeTimers();
    try {
      const readSession = vi.fn().mockResolvedValue({ status: "running" });
      const readOutput = vi.fn().mockResolvedValue("");
      const pending = __test__.waitForSupervisorPromptRunOutcome({
        sessionId: "sess-run-finished",
        outputPath: "/tmp/out.md",
        run: new Promise<void>((resolve) => {
          setTimeout(resolve, 500);
        }),
        readSession,
        readOutput,
        pollIntervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(600);

      await expect(pending).resolves.toEqual({ kind: "run-finished" });
      const pollCountAfterResolve = readSession.mock.calls.length;

      await vi.advanceTimersByTimeAsync(5_000);

      expect(readSession).toHaveBeenCalledTimes(pollCountAfterResolve);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
