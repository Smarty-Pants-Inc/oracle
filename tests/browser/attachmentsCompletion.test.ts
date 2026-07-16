import { describe, expect, test, vi } from "vitest";
import {
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
} from "../../src/browser/pageActions.js";
import type { ChromeClient } from "../../src/browser/types.js";

const useFakeTime = () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
};

const useRealTime = () => {
  vi.useRealTimers();
};

describe("attachment completion fallbacks", () => {
  test("waitForAttachmentCompletion accepts stable count evidence with a disabled send button", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "disabled",
              uploading: false,
              filesAttached: true,
              attachedNames: ["Remove file", "1 file", "24.4 MB"],
              inputNames: [],
              fileCount: 1,
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion times out while upload progress remains active", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "disabled",
              uploading: true,
              filesAttached: true,
              attachedNames: ["oracle-attach-verify.txt"],
              inputNames: [],
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
      const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion restarts stability after upload progress clears", async () => {
    useFakeTime();
    try {
      const evaluate = vi.fn().mockImplementation(async () => {
        const uploading = evaluate.mock.calls.length <= 3;
        return {
          result: {
            value: {
              state: "disabled",
              uploading,
              filesAttached: true,
              attachedNames: ["oracle-attach-verify.txt"],
              inputNames: [],
            },
          },
        };
      });
      const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(evaluate).toHaveBeenCalledTimes(9);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion accepts stable matching file-input evidence", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "missing",
              uploading: false,
              filesAttached: false,
              attachedNames: [],
              inputNames: ["oracle-attach-verify.txt"],
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion rejects active upload despite matching file-input evidence", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "disabled",
              uploading: true,
              filesAttached: false,
              attachedNames: [],
              inputNames: ["oracle-attach-verify.txt"],
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
      const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion rejects a mismatched name even when count matches", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "ready",
              uploading: false,
              filesAttached: true,
              attachedNames: ["other-file.txt"],
              inputNames: ["other-file.txt"],
              fileCount: 1,
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
      const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion rejects an extensionless mismatch even when count matches", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "ready",
              uploading: false,
              filesAttached: true,
              attachedNames: ["otherfile"],
              inputNames: [],
              fileCount: 1,
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
      const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion rejects a rendered filename with a distinct prefix", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "disabled",
              uploading: false,
              filesAttached: true,
              attachedNames: ["old oracle-attach-verify.txt"],
              inputNames: [],
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
      const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion rejects a rendered suffix collision", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "disabled",
              uploading: false,
              filesAttached: true,
              attachedNames: ["old-oracle-attach-verify.txt"],
              inputNames: [],
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
      const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion rejects a same-stem different-extension file input", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "disabled",
              uploading: false,
              filesAttached: false,
              attachedNames: [],
              inputNames: ["oracle-attach-verify.pdf"],
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
      const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("waitForAttachmentCompletion rejects a suffix collision in file-input evidence", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              state: "disabled",
              uploading: false,
              filesAttached: false,
              attachedNames: [],
              inputNames: ["old-oracle-attach-verify.txt"],
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
      const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });
});

describe("sent turn attachment verification", () => {
  test("waitForUserTurnAttachments resolves when last user turn includes filename", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\noracle-attach-verify.txt\nDocument",
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 1000),
    ).resolves.toBe(true);
  });

  test("waitForUserTurnAttachments times out when filename never appears", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment name here)",
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 600);
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForUserTurnAttachments skips when user turn lacks attachment UI", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment UI here)",
            attrs: [],
            hasAttachmentUi: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 600);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test("waitForUserTurnAttachments resolves when attachment UI count satisfies expected files (no filename text)", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment name here)",
            attrs: [],
            hasAttachmentUi: true,
            attachmentUiCount: 2,
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      waitForUserTurnAttachments(
        runtime,
        ["oracle-attach-verify-a.txt", "oracle-attach-verify-b.txt"],
        1000,
      ),
    ).resolves.toBe(true);
  });

  test("waitForUserTurnAttachments ignores turns before the expected baseline", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        minTurnIndex: 4,
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test("waitForUserTurnAttachments requires prompt evidence when provided", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said: unrelated prompt oracle-attach-verify.txt",
            attrs: [],
            hasAttachmentUi: true,
            promptMatches: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        expectedPrompt: "expected prompt text",
      },
    );
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForUserTurnAttachments ignores mismatched conversations", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
            conversationMismatch: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        expectedConversationId: "conv-123",
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });
});
