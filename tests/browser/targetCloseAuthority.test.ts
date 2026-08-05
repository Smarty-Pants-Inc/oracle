import { afterEach, describe, expect, test, vi } from "vitest";
import {
  __test__,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import type { BrowserLogger } from "../../src/browser/types.js";

describe("retained Chrome target close capabilities", () => {
  afterEach(() => {
    __test__.clearRetainedTargetCloseAuthorities();
  });

  test("bounds completed tombstones while retaining recent idempotence and rejecting unknown capabilities", async () => {
    const close = vi.fn(async () => ({ status: "completed" as const }));
    const logger = vi.fn<(message: string) => void>() as BrowserLogger;
    const count = __test__.retainedTerminalTargetCloseCapabilityLimit * 4;
    const capabilities = Array.from({ length: count }, (_, index) =>
      retainChromeTargetCloseCapability({
        generationId: `generation-${index}`,
        targetId: `target-${index}`,
        close,
      }),
    );

    for (const [index, capability] of capabilities.entries()) {
      await expect(
        closeChromeTargetWithRetainedCapability({
          capability,
          targetId: `target-${index}`,
          logger,
        }),
      ).resolves.toEqual({ status: "completed" });
    }

    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(
      __test__.retainedTerminalTargetCloseCapabilityLimit,
    );

    const newest = capabilities.at(-1)!;
    await expect(
      closeChromeTargetWithRetainedCapability({
        capability: newest,
        targetId: `target-${count - 1}`,
        logger,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(close).toHaveBeenCalledTimes(count);

    await expect(
      closeChromeTargetWithRetainedCapability({
        capability: capabilities[0],
        targetId: "target-0",
        logger,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      closeChromeTargetWithRetainedCapability({
        capability: {
          version: 1,
          generationId: "unknown-generation",
          capabilityId: "unknown-capability",
        },
        targetId: "unknown-target",
        logger,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(close).toHaveBeenCalledTimes(count);
  });
});
