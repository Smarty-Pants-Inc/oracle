import { describe, expect, test } from "vitest";
import { MAX_DATA_TRANSFER_BYTES } from "../../src/browser/actions/attachmentDataTransfer.js";

describe("attachment data transfer", () => {
  test("uses the browser attachment ceiling", () => {
    expect(MAX_DATA_TRANSFER_BYTES).toBe(512 * 1024 * 1024);
  });
});
