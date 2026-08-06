import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sessionStoreMock = {
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/.oracle/sessions"),
};

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
}));

vi.mock("../../src/sessionManager.ts", () => ({
  wait: vi.fn(),
  writeFileAtomicDurable: vi.fn(),
}));

describe("showStatus cleanup tip", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionStoreMock.listSessions.mockResolvedValue([]);
    sessionStoreMock.filterSessions.mockReturnValue({ entries: [], truncated: false, total: 0 });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test("prints cleanup tip when no sessions found", async () => {
    const { showStatus } = await import("../../src/cli/sessionDisplay.ts");
    await showStatus({ hours: 24, includeAll: false, limit: 10, showExamples: false });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("oracle session --clear"));
  }, 15_000);
});
