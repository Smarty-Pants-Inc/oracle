import { afterEach, describe, expect, test, vi } from "vitest";
import {
  __test__,
  acknowledgeChromeTargetCloseCapability,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import type { BrowserLogger } from "../../src/browser/types.js";

describe("retained Chrome target close capabilities", () => {
  afterEach(() => {
    __test__.clearRetainedTargetCloseAuthorities();
  });

  test("pins unacknowledged terminal capabilities while bounding acknowledged tombstones", async () => {
    const close = vi.fn(async () => ({ status: "completed" as const }));
    const logger = vi.fn<(message: string) => void>() as BrowserLogger;
    const pending = retainChromeTargetCloseCapability({
      generationId: "pending-generation",
      targetId: "pending-target",
      close,
    });
    await expect(
      closeChromeTargetWithRetainedCapability({
        capability: pending,
        targetId: "pending-target",
        logger,
      }),
    ).resolves.toEqual({ status: "completed" });

    const count = __test__.retainedTerminalTargetCloseCapabilityLimit * 4;
    const acknowledged: (typeof pending)[] = [];
    for (let index = 0; index < count; index += 1) {
      const capability = retainChromeTargetCloseCapability({
        generationId: `generation-${index}`,
        targetId: `target-${index}`,
        close,
      });
      await closeChromeTargetWithRetainedCapability({
        capability,
        targetId: `target-${index}`,
        logger,
      });
      acknowledgeChromeTargetCloseCapability({ capability, targetId: `target-${index}` });
      acknowledged.push(capability);
    }

    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(
      __test__.retainedTerminalTargetCloseCapabilityLimit + 1,
    );
    expect(__test__.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      __test__.retainedTerminalTargetCloseCapabilityLimit,
    );
    await expect(
      closeChromeTargetWithRetainedCapability({
        capability: pending,
        targetId: "pending-target",
        logger,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(close).toHaveBeenCalledTimes(count + 1);

    acknowledgeChromeTargetCloseCapability({ capability: pending, targetId: "pending-target" });
    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(
      __test__.retainedTerminalTargetCloseCapabilityLimit,
    );
    await expect(
      closeChromeTargetWithRetainedCapability({
        capability: acknowledged[0]!,
        targetId: "target-0",
        logger,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      closeChromeTargetWithRetainedCapability({
        capability: pending,
        targetId: "pending-target",
        logger,
      }),
    ).resolves.toEqual({ status: "completed" });
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
    expect(close).toHaveBeenCalledTimes(count + 1);
  });
});
