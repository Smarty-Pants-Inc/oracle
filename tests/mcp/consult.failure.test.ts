import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";

const baseSession: SessionMetadata = {
  id: "sess-timeout",
  createdAt: "2026-06-10T00:00:00.000Z",
  status: "running",
  cwd: "/tmp/oracle",
  mode: "browser",
  model: "gpt-5.6-sol-pro",
  options: { prompt: "review", file: [], model: "gpt-5.6-sol-pro", mode: "browser" },
};

const createSession = vi.fn(async () => baseSession);
const readSession = vi.fn(async () => null as SessionMetadata | null);
const readLog = vi.fn(async () => "");
const createLogWriter = vi.fn(() => ({
  logLine: vi.fn(),
  writeChunk: vi.fn(),
  stream: { end: vi.fn() },
}));
const performSessionRun = vi.fn();
const loadUserConfig = vi.fn(async () => ({ config: {}, path: null, loaded: false }));
const resolveRemoteServiceConfig = vi.fn(() => ({}));
const resolveNotificationSettings = vi.fn(() => ({}));

vi.mock("../../src/sessionStore.js", async () => {
  const original = await vi.importActual<typeof import("../../src/sessionStore.js")>(
    "../../src/sessionStore.js",
  );
  return {
    ...original,
    sessionStore: {
      ...original.sessionStore,
      createSession,
      readSession,
      readLog,
      createLogWriter,
    },
  };
});
vi.mock("../../src/cli/sessionRunner.js", () => ({ performSessionRun }));
vi.mock("../../src/config.js", () => ({ loadUserConfig }));
vi.mock("../../src/remote/remoteServiceConfig.js", () => ({ resolveRemoteServiceConfig }));
vi.mock("../../src/cli/notifier.js", () => ({ resolveNotificationSettings }));

const { registerConsultTool } = await import("../../src/mcp/tools/consult.ts");

describe("consult MCP failure diagnostics", () => {
  let handler: ((input: unknown) => Promise<unknown>) | null = null;
  const sendLoggingMessage = vi.fn(async () => undefined);

  beforeEach(() => {
    handler = null;
    createSession.mockClear();
    readSession.mockReset();
    readLog.mockReset();
    createLogWriter.mockClear();
    performSessionRun.mockReset();
    loadUserConfig.mockClear();
    resolveRemoteServiceConfig.mockClear();
    resolveNotificationSettings.mockClear();
    sendLoggingMessage.mockClear();
    registerConsultTool({
      registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      server: { sendLoggingMessage },
    } as unknown as Parameters<typeof registerConsultTool>[0]);
    if (!handler) throw new Error("handler not registered");
  });

  test("returns a structured blocker when a browser consult times out", async () => {
    const finalSession: SessionMetadata = {
      ...baseSession,
      status: "error",
      errorMessage: "assistant timed out",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      error: {
        category: "browser-automation",
        message: "assistant timed out",
        details: { stage: "assistant-timeout" },
      },
    };
    readSession.mockResolvedValue(finalSession);
    readLog.mockResolvedValue("Assistant response timed out; reattach later.");
    performSessionRun.mockRejectedValue(new Error("assistant timed out"));

    const result = (await handler?.({
      engine: "browser",
      model: "gpt-5.6-sol-pro",
      prompt: "review this",
      files: [],
    })) as {
      isError?: boolean;
      content: Array<{ type: "text"; text: string }>;
      structuredContent?: {
        sessionId?: string;
        status: string;
        output: string;
        agentBlocker?: {
          kind: string;
          resumable: boolean;
          resumeCommand?: string;
        };
      };
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Session sess-timeout failed");
    expect(result.structuredContent).toMatchObject({
      sessionId: "sess-timeout",
      status: "error",
      output: expect.stringContaining("Assistant response timed out"),
      agentBlocker: {
        kind: "timeout",
        resumable: true,
        resumeCommand: "oracle session sess-timeout",
      },
    });
  });
});
