import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  MAX_DATA_TRANSFER_BYTES,
  transferAttachmentViaDataTransfer,
} from "../../src/browser/actions/attachmentDataTransfer.js";

describe("attachment data transfer", () => {
  test("uses the browser attachment ceiling", () => {
    expect(MAX_DATA_TRANSFER_BYTES).toBe(512 * 1024 * 1024);
  });

  test("rechecks page affinity immediately before evaluating the transfer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-transfer-"));
    const filePath = path.join(directory, "attachment.txt");
    await writeFile(filePath, "sensitive attachment");
    const evaluate = vi.fn();
    const assertPageAffinity = vi.fn().mockRejectedValue(new Error("page affinity changed"));
    try {
      await expect(
        transferAttachmentViaDataTransfer(
          { evaluate } as never,
          { path: filePath, displayPath: "attachment.txt" },
          'input[type="file"]',
          assertPageAffinity,
        ),
      ).rejects.toThrow(/page affinity changed/i);
      expect(assertPageAffinity).toHaveBeenCalledWith("attachment transfer");
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
