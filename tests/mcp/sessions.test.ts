import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadata, StoredRunOptions } from "../../src/sessionManager.js";

const listSessions = vi.fn(async () => [] as SessionMetadata[]);
const filterSessions = vi.fn(
  (_metas: SessionMetadata[], _opts: { hours?: number; includeAll?: boolean; limit?: number }) => ({
    entries: [] as SessionMetadata[],
    truncated: false,
    total: 0,
  }),
);
const readSession = vi.fn(async (_id: string) => null as SessionMetadata | null);
const readLog = vi.fn(async (_id: string) => "");
const readRequest = vi.fn(async (_id: string) => null as StoredRunOptions | null);

vi.mock("../../src/sessionStore.js", async () => {
  const original = await vi.importActual<typeof import("../../src/sessionStore.js")>(
    "../../src/sessionStore.js",
  );
  return {
    ...original,
    sessionStore: {
      ...original.sessionStore,
      listSessions,
      filterSessions,
      readSession,
      readLog,
      readRequest,
    },
  };
});

const { registerSessionsTool } = await import("../../src/mcp/tools/sessions.ts");

describe("sessions MCP tool", () => {
  let handler: ((input: unknown) => Promise<unknown>) | null = null;

  beforeEach(() => {
    listSessions.mockReset();
    filterSessions.mockReset();
    readSession.mockReset();
    readLog.mockReset();
    readRequest.mockReset();
    handler = null;
    registerSessionsTool({
      registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
        handler = fn;
      },
    } as unknown as Parameters<typeof registerSessionsTool>[0]);
    if (!handler) throw new Error("handler not registered");
  });

  it("lists sessions with defaults when no id provided", async () => {
    const meta: SessionMetadata = {
      id: "s1",
      createdAt: "2025-11-21T00:00:00Z",
      status: "completed",
      cwd: "/tmp",
      model: "gpt-5.1",
      mode: "api",
      options: { prompt: "p", file: [], model: "gpt-5.1" },
    };
    listSessions.mockResolvedValue([meta]);
    filterSessions.mockReturnValue({ entries: [meta], truncated: false, total: 1 });

    const result = (await handler?.({})) as {
      structuredContent: { entries: SessionMetadata[]; total: number; truncated: boolean };
    };
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(filterSessions).toHaveBeenCalledWith([meta], {
      hours: 24,
      includeAll: false,
      limit: 100,
    });
    expect(result.structuredContent.entries).toHaveLength(1);
    expect(result.structuredContent.entries[0].id).toBe("s1");
    expect(result.structuredContent.total).toBe(1);
  });

  it("throws when id is missing", async () => {
    readSession.mockResolvedValue(null);
    await expect(handler?.({ id: "missing" })).rejects.toThrow('Session "missing" not found.');
    expect(readSession).toHaveBeenCalledWith("missing");
  });

  it("returns summary entry when id is found and detail=false", async () => {
    const meta: SessionMetadata = {
      id: "s2",
      createdAt: "2025-11-21T00:00:00Z",
      status: "running",
      cwd: "/tmp",
      model: "gpt-5.2-pro",
      mode: "api",
      options: { prompt: "p", file: [], model: "gpt-5.2-pro" },
    };
    readSession.mockResolvedValue(meta);
    const result = (await handler?.({ id: "s2" })) as {
      structuredContent: { entries: SessionMetadata[] };
    };
    expect(readSession).toHaveBeenCalledWith("s2");
    expect(result.structuredContent.entries[0]).toEqual(
      expect.objectContaining({ id: "s2", status: "running", model: "gpt-5.2-pro", mode: "api" }),
    );
  });

  it("returns metadata/log/request when detail=true", async () => {
    const meta: SessionMetadata = {
      id: "detail",
      createdAt: "2025-11-21T00:00:00Z",
      status: "completed",
      cwd: "/tmp",
      model: "gpt-5.1",
      mode: "api",
      options: { prompt: "p", file: [], model: "gpt-5.1" },
      browser: {
        runtime: {
          submittedPromptText: "private recovery prompt",
          submittedPromptIndex: 0,
        },
      },
      error: {
        details: {
          runtime: {
            submittedPromptText: "nested private recovery prompt",
          },
        },
      },
    };
    readSession.mockResolvedValue(meta);
    readLog.mockResolvedValue("hello log");
    readRequest.mockResolvedValue({ prompt: "hi" } as StoredRunOptions);

    const result = (await handler?.({ id: "detail", detail: true })) as {
      structuredContent: {
        session: { metadata: SessionMetadata; log: string; request?: StoredRunOptions };
      };
    };

    expect(readSession).toHaveBeenCalledWith("detail");
    expect(readLog).toHaveBeenCalledWith("detail");
    expect(readRequest).toHaveBeenCalledWith("detail");
    expect(result.structuredContent.session.metadata.id).toBe("detail");
    expect(result.structuredContent.session.metadata.browser?.runtime).toMatchObject({
      submittedPromptText: "[redacted]",
      submittedPromptIndex: 0,
    });
    expect(
      (
        result.structuredContent.session.metadata.error?.details?.runtime as
          | { submittedPromptText?: string }
          | undefined
      )?.submittedPromptText,
    ).toBe("[redacted]");
    expect(meta.browser?.runtime?.submittedPromptText).toBe("private recovery prompt");
    expect(result.structuredContent.session.log).toContain("hello log");
    expect(result.structuredContent.session.request).toEqual(
      expect.objectContaining({ prompt: "hi" }),
    );
  });
});
