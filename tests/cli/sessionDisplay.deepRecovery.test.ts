import { describe, expect, test } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.ts";
import {
  isDeepResearchPlaceholderCapture,
  trimBeforeFirstAnswer,
} from "../../src/cli/sessionDisplay.ts";

describe("trimBeforeFirstAnswer", () => {
  test("returns log starting at first Answer marker", () => {
    const input = "intro\nnoise\nAnswer:\nactual content\n";
    expect(trimBeforeFirstAnswer(input)).toBe("Answer:\nactual content\n");
  });

  test("returns original text when marker missing", () => {
    const input = "no answer yet";
    expect(trimBeforeFirstAnswer(input)).toBe(input);
  });

  test("skips stale tool-only capture when a later reattach answer exists", () => {
    const input =
      "Launching browser mode\n" +
      "Answer:\n" +
      "Called tool\n" +
      "[reattach] captured assistant response from existing Chrome tab\n" +
      "Answer:\n" +
      "Recovered report";

    expect(trimBeforeFirstAnswer(input)).toBe("Answer:\nRecovered report");
  });

  test("skips a stale Deep Research App wrapper before a recovered answer", () => {
    const input =
      "Answer:\n" +
      "Called tool\n" +
      "Deep Research App\n" +
      "Response { session_id: abc123 }\n" +
      "[reattach] captured assistant response from existing Chrome tab\n" +
      "Answer:\n" +
      "# Recovered report";

    expect(trimBeforeFirstAnswer(input)).toBe("Answer:\n# Recovered report");
  });
});
describe("isDeepResearchPlaceholderCapture", () => {
  const deepResearchMeta: SessionMetadata = {
    id: "sess",
    createdAt: new Date().toISOString(),
    status: "completed",
    options: {},
  };

  test("flags the bare tool-only stub", () => {
    const log = "Launching browser mode\nAnswer:\nCalled tool\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(true);
  });

  test("flags the multi-line Deep Research App tool-call wrapper", () => {
    const log =
      "Launching browser mode\n" +
      "Answer:\n" +
      "Called tool\n" +
      "Deep Research App\n" +
      "Call tool\n" +
      "Request { prompt: ... }\n" +
      "Response { session_id: abc123 }\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(true);
  });

  test("flags Polish tool-call markers", () => {
    const log = "Answer:\nUżyto narzędzia\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(true);
  });

  test("does not flag a real report answer", () => {
    const log =
      "Answer:\n" +
      "# Research Report\n" +
      "The findings show that the market grew 12% year over year.\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(false);
  });

  test("does not flag prose that happens to begin with a tool-call phrase", () => {
    const log =
      "Answer:\n" +
      "Called tool adoption is accelerating across the market.\n" +
      "The report analyzes the evidence in detail.\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(false);
  });

  test("does not re-flag a wrapper capture that was already recovered", () => {
    const log =
      "Answer:\n" +
      "Called tool\n" +
      "Deep Research App\n" +
      "Response { session_id: abc123 }\n" +
      "[reattach] captured assistant response from existing Chrome tab\n" +
      "Answer:\n" +
      "# Research Report\n" +
      "The recovered findings.\n";
    expect(isDeepResearchPlaceholderCapture(deepResearchMeta, log)).toBe(false);
  });
});
