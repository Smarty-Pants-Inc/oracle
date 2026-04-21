import { beforeEach, describe, expect, test, vi } from "vitest";

const sessionStoreMock = vi.hoisted(() => ({
  createSession: vi.fn(),
  createLogWriter: vi.fn(),
  readSession: vi.fn(),
  readLog: vi.fn(),
}));

const performSessionRunMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
}));

vi.mock("../../src/cli/sessionRunner.ts", () => ({
  performSessionRun: performSessionRunMock,
}));

vi.mock("../../src/config.ts", () => ({
  loadUserConfig: vi.fn(async () => ({ config: {} })),
}));

vi.mock("../../src/mcp/utils.ts", () => ({
  ensureBrowserAvailable: vi.fn(() => null),
  mapConsultToRunOptions: vi.fn(({ prompt, files, model, models, engine }) => ({
    runOptions: {
      prompt,
      file: files ?? [],
      model: model ?? "gpt-5.2",
      models,
    },
    resolvedEngine: engine ?? "api",
  })),
}));

vi.mock("../../src/remote/remoteServiceConfig.ts", () => ({
  resolveRemoteServiceConfig: vi.fn(() => ({})),
}));

vi.mock("../../src/cli/notifier.ts", () => ({
  resolveNotificationSettings: vi.fn(() => ({ enabled: false, sound: false })),
}));

import { registerConsultTool } from "../../src/mcp/tools/consult.ts";

function getConsultHandler() {
  const registerTool = vi.fn();
  const sendLoggingMessage = vi.fn(async () => undefined);
  registerConsultTool({
    registerTool,
    server: { sendLoggingMessage },
  } as never);
  return registerTool.mock.calls[0]?.[2] as (input: unknown) => Promise<unknown>;
}

describe("consult receipt finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreMock.createSession.mockResolvedValue({
      id: "sess-1",
      createdAt: "2026-04-21T00:00:00.000Z",
      status: "pending",
      options: {},
    });
    sessionStoreMock.createLogWriter.mockReturnValue({
      logLine: vi.fn(),
      writeChunk: vi.fn(),
      stream: { end: vi.fn() },
    });
    sessionStoreMock.readLog.mockResolvedValue("Answer:\nHello from Oracle\n");
    performSessionRunMock.mockResolvedValue(undefined);
  });

  test("returns success only after the canonical reply is persisted", async () => {
    sessionStoreMock.readSession.mockResolvedValue({
      id: "sess-1",
      createdAt: "2026-04-21T00:00:00.000Z",
      status: "completed",
      options: {},
      response: {
        status: "completed",
        assistantOutput: "Hello from Oracle",
      },
    });

    const handler = getConsultHandler();
    const result = (await handler({
      prompt: "Reply with one short sentence.",
      model: "gpt-5.2",
      engine: "api",
    })) as {
      isError?: boolean;
      structuredContent?: { sessionId?: string; status?: string };
    };

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      sessionId: "sess-1",
      status: "completed",
    });
  });

  test("fails closed when a completed session is missing assistantOutput", async () => {
    sessionStoreMock.readSession.mockResolvedValue({
      id: "sess-1",
      createdAt: "2026-04-21T00:00:00.000Z",
      status: "completed",
      options: {},
      response: {
        status: "completed",
      },
    });

    const handler = getConsultHandler();
    const result = (await handler({
      prompt: "Reply with one short sentence.",
      model: "gpt-5.2",
      engine: "api",
    })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("completed without a canonical persisted reply");
  });
});
