import { describe, expect, test, vi } from "vitest";
import type { ChromeClient } from "../../src/browser/types.js";
import {
  assertChatGptAccountAffinity,
  assertChatGptAccountEmail,
  normalizeChatGptAccountDigest,
  normalizeChatGptAccountEmail,
  readChatGptAccountIdentity,
} from "../../src/browser/chatgptAccount.js";

function runtimeReturning(value: unknown): ChromeClient["Runtime"] {
  return {
    evaluate: vi.fn(async () => ({ result: { value } })),
  } as unknown as ChromeClient["Runtime"];
}

describe("ChatGPT account affinity", () => {
  const accountDigest = "a".repeat(64);

  test("reads and normalizes authenticated identity through page context", async () => {
    const Runtime = runtimeReturning({
      accountDigest,
      email: " OWNER@EXAMPLE.TEST ",
    });

    await expect(readChatGptAccountIdentity(Runtime, 250)).resolves.toEqual({
      accountDigest,
      email: "owner@example.test",
    });
    await expect(
      assertChatGptAccountEmail(Runtime, "OWNER@example.test", "inventory", 250),
    ).resolves.toBe(accountDigest);
    const expression = vi.mocked(Runtime.evaluate).mock.calls[0]?.[0]?.expression;
    expect(expression).toContain("/api/auth/session");
    expect(expression).toContain("AbortController");
    expect(expression).toContain("signal: controller.signal");
    expect(expression).toContain("const timeoutMs = 250");
    expect(expression).toContain("rawUserId.length > 0 && rawUserId.length <= 512");
    expect(expression).toContain("rawEmail.length <= 320");
  });

  test("rejects malformed and oversized account identity fields", () => {
    expect(normalizeChatGptAccountDigest("a".repeat(65))).toBeUndefined();
    expect(normalizeChatGptAccountDigest("not-a-digest")).toBeUndefined();
    expect(normalizeChatGptAccountEmail("owner@example")).toBeUndefined();
    expect(normalizeChatGptAccountEmail(`${"a".repeat(310)}@example.test`)).toBeUndefined();
  });

  test("fails closed when the host-side account identity evaluation exceeds its budget", async () => {
    const Runtime = {
      evaluate: vi.fn(() => Promise.race([])),
    } as unknown as ChromeClient["Runtime"];

    await expect(readChatGptAccountIdentity(Runtime, 1)).rejects.toThrow(
      "Timed out while reading authenticated ChatGPT account identity.",
    );
  });

  test("fails closed on account digest or expected email mismatch without disclosing email", async () => {
    const Runtime = runtimeReturning({ accountDigest, email: "other@example.test" });

    await expect(
      assertChatGptAccountAffinity(Runtime, "b".repeat(64), "owner@example.test", "inventory"),
    ).rejects.toThrow(/account identity changed before inventory/i);

    const emailError = await assertChatGptAccountAffinity(
      Runtime,
      accountDigest,
      "owner@example.test",
      "inventory",
    ).catch((error: unknown) => error);
    expect(emailError).toBeInstanceOf(Error);
    expect((emailError as Error).message).toMatch(/email changed before inventory/i);
    expect((emailError as Error).message).not.toContain("owner@example.test");
    expect((emailError as Error).message).not.toContain("other@example.test");
  });
});
