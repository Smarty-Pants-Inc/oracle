import { describe, expect, test, vi } from "vitest";
import type { RemoteTransactionCoordinator } from "../../src/remote/transactionCoordinator.js";
import type { RemoteTransactionRecord } from "../../src/remote/transactionModel.js";
import type { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { settleRemoteControllerShutdown } from "../../src/remote/transactionServer.js";

describe("settleRemoteControllerShutdown", () => {
  test("redacts the full token from a pending-cleanup shutdown error", async () => {
    const transactionToken = "a".repeat(64);
    const record = { state: "pending", transactionToken } as RemoteTransactionRecord;
    const settle = vi.fn(async () => ({ record, finalization: { status: "pending" } }));
    const logger = vi.fn();

    let error: unknown;
    try {
      await settleRemoteControllerShutdown({
        transactionStore: {
          list: vi.fn(async () => [record]),
          prepareControllerShutdown: vi.fn(async () => ({
            action: "settle",
            mode: "finalize",
            durablePublication: true,
            record,
          })),
        } as unknown as RemoteTransactionStore,
        transactionCoordinator: {
          settle,
          activeTransactionTokens: vi.fn(() => []),
        } as unknown as RemoteTransactionCoordinator,
        activeTransactions: new Map(),
        logger,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.includes(transactionToken)).toBe(false);
    expect(message).toContain(transactionToken.slice(0, 12));
    expect(message).toContain("cleanup remains pending");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(logger).not.toHaveBeenCalled();
  });
});
