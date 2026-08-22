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

  test("checks affinity immediately before mutating the browser file input", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-transfer-"));
    try {
      const file = path.join(tmp, "note.txt");
      await writeFile(file, "hello", "utf8");
      const beforeMutation = vi.fn();
      const evaluate = vi.fn().mockResolvedValue({
        result: { value: { success: true, fileName: "note.txt", size: 5 } },
      });

      await transferAttachmentViaDataTransfer(
        { evaluate } as never,
        { path: file, displayPath: "note.txt" },
        'input[type="file"]',
        beforeMutation,
      );

      expect(beforeMutation).toHaveBeenCalledOnce();
      expect(beforeMutation.mock.invocationCallOrder[0]).toBeLessThan(
        evaluate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("does not mutate the file input when the affinity check fails", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-transfer-"));
    try {
      const file = path.join(tmp, "note.txt");
      await writeFile(file, "hello", "utf8");
      const evaluate = vi.fn();

      await expect(
        transferAttachmentViaDataTransfer(
          { evaluate } as never,
          { path: file, displayPath: "note.txt" },
          'input[type="file"]',
          async () => {
            throw new Error("affinity changed");
          },
        ),
      ).rejects.toThrow("affinity changed");
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
