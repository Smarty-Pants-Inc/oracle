import { describe, expect, test } from "vitest";

import { sanitizeErrorForPersistence, toTransportError } from "@src/oracle/errors.js";

// Minimal stub matching openai APIError signature without pulling undici Headers.
class FakeApiError extends Error {
  status: number;
  error: { message?: string; code?: string; param?: string };
  code?: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "APIError";
    this.status = 400;
    this.error = { message, code, param: "model" };
    this.code = code;
  }
}

describe("toTransportError", () => {
  test("maps pro model_not_found to model-unavailable with guidance", () => {
    const apiError = new FakeApiError("The requested model does not exist", "model_not_found");
    const transport = toTransportError(apiError, "gpt-5.5-pro");
    expect(transport.reason).toBe("model-unavailable");
    expect(transport.message).toContain("gpt-5.5-pro");
    expect(transport.message).toContain("gpt-5-pro");
  });

  test("maps generic API error to api-error with message", () => {
    const apiError = new FakeApiError("Rate limit exceeded", "rate_limit_exceeded");
    const transport = toTransportError(apiError, "gpt-5.1");
    expect(transport.reason).toBe("api-error");
    expect(transport.message).toContain("Rate limit exceeded");
  });
});

describe("sanitizeErrorForPersistence", () => {
  test("redacts nested URL strings without mutating diagnostics and tolerates cycles", () => {
    const signedUrl = "https://chatgpt.com/c/private?signature=secret#fragment";
    const details: Record<string, unknown> = {
      stage: "chatgpt-scope",
      code: "scope-mismatch",
      sessionStatus: "needs_login",
      validationReason: "route changed",
      actualUrl: signedUrl,
      expectedUrl: signedUrl,
      recoveryHandle: {
        transport: "obu",
        sessionId: "session-1",
        tabId: 7,
        conversationUrl: signedUrl,
      },
      cleanupFailure: {
        message: `Cleanup failed at ${signedUrl}`,
        details: {
          note: `See ${signedUrl}`,
          attempts: [signedUrl, "safe diagnostic"],
        },
      },
    };
    details.self = details;

    const sanitized = sanitizeErrorForPersistence(
      `Operation failed at ${signedUrl}`,
      details,
      "harvest",
    );

    expect(sanitized).toMatchObject({
      message: "Operation failed at [redacted-url]",
      details: {
        stage: "chatgpt-scope",
        code: "scope-mismatch",
        sessionStatus: "needs_login",
        validationReason: "route changed",
        expectedUrl: "[redacted-url]",
        recoveryHandle: {
          transport: "obu",
          sessionId: "session-1",
          tabId: 7,
          conversationUrl: "[redacted-url]",
        },
        cleanupFailure: {
          message: "Cleanup failed at [redacted-url]",
          details: {
            note: "See [redacted-url]",
            attempts: ["[redacted-url]", "safe diagnostic"],
          },
        },
        oracleOperation: "harvest",
      },
    });
    expect(sanitized.details).not.toHaveProperty("actualUrl");
    expect(sanitized.details).not.toHaveProperty("self");
    expect(details.actualUrl).toBe(signedUrl);
    expect(JSON.stringify(sanitized)).not.toContain(signedUrl);
    expect(JSON.stringify(sanitized)).not.toContain("signature=secret");
  });
});
