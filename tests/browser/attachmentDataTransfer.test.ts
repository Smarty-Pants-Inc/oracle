import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  MAX_DATA_TRANSFER_BYTES,
  transferAttachmentViaDataTransfer,
} from "../../src/browser/actions/attachmentDataTransfer.js";
import { uploadAttachmentViaDataTransfer } from "../../src/browser/actions/remoteFileTransfer.js";

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

  test("guards byte assignment and rechecks affinity after attachment visibility", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-transfer-affinity-"));
    const filePath = path.join(directory, "attachment.txt");
    await writeFile(filePath, "sensitive attachment");
    const expressions: string[] = [];
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        expressions.push(expression);
        return expression.includes("const base64Data")
          ? { result: { value: { success: true, fileName: "attachment.txt", size: 20 } } }
          : { result: { value: { found: true, source: "file-input" } } };
      }),
    };
    const assertPageAffinity = vi.fn(async () => undefined);
    try {
      const upload = uploadAttachmentViaDataTransfer(
        {
          runtime: runtime as never,
          dom: {
            getDocument: vi.fn(async () => ({ root: { nodeId: 1 } })),
            querySelector: vi.fn(async () => ({ nodeId: 2 })),
          } as never,
          assertPageAffinity,
          expectedConversationId: "expected-thread",
          expectedAccountDigest: "a".repeat(64),
        },
        { path: filePath, displayPath: "attachment.txt" },
        vi.fn() as never,
      );
      await upload;
      const transferExpression = expressions[0] ?? "";
      expect(transferExpression).toContain('const expectedConversationId = "expected-thread"');
      expect(transferExpression.indexOf("await assertOracleChatGptPageAffinity();")).toBeLessThan(
        transferExpression.indexOf("const base64Data"),
      );
      expect(
        transferExpression.lastIndexOf("await assertOracleChatGptPageAffinity();"),
      ).toBeGreaterThan(transferExpression.indexOf("dispatchEvent"));
      expect(assertPageAffinity).toHaveBeenCalledWith("attachment visibility confirmation");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
