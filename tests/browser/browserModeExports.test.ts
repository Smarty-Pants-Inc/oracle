import { describe, expect, test } from "vitest";
import * as browserApi from "../../src/browser/index.js";
import * as browserMode from "../../src/browserMode.js";

describe("browserMode exports", () => {
  test("keeps transaction control internal while preserving the released browser API", () => {
    expect(typeof browserMode.runBrowserMode).toBe("function");
    expect(typeof browserMode.CHATGPT_URL).toBe("string");
    expect(browserMode).not.toHaveProperty("runBrowserModeTransaction");
    expect(browserApi).not.toHaveProperty("runBrowserModeTransaction");
  });
});
