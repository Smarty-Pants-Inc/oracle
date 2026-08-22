import { describe, expect, test, vi } from "vitest";
import type { ChromeClient } from "../../src/browser/types.js";
import {
  assertChatGptAccountAffinity,
  assertChatGptAccountEmail,
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

    await expect(readChatGptAccountIdentity(Runtime)).resolves.toEqual({
      accountDigest,
      email: "owner@example.test",
    });
    await expect(
      assertChatGptAccountEmail(Runtime, "OWNER@example.test", "inventory"),
    ).resolves.toBe(accountDigest);
    expect(vi.mocked(Runtime.evaluate).mock.calls[0]?.[0]?.expression).toContain(
      "/api/auth/session",
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
