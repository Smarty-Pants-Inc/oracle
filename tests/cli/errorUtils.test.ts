import { describe, expect, test } from "vitest";
import { formatError, isErrorLogged, markErrorLogged } from "../../src/cli/errorUtils.ts";

describe("errorUtils", () => {
  test("marks errors as logged", () => {
    const err = new Error("boom");
    expect(isErrorLogged(err)).toBe(false);
    markErrorLogged(err);
    expect(isErrorLogged(err)).toBe(true);
  });

  test("renders Error messages and non-Error values", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
    expect(formatError({ code: "boom" })).toBe("[object Object]");
  });

  test("ignores non-error values", () => {
    expect(isErrorLogged("oops")).toBe(false);
    markErrorLogged("oops");
    expect(isErrorLogged("oops")).toBe(false);
  });
});
