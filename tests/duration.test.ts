import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/duration.js";

const FALLBACK = 42;

describe("parseDuration", () => {
  it("parses bare numbers and single units", () => {
    expect(parseDuration("1500", FALLBACK)).toBe(1500);
    expect(parseDuration("500ms", FALLBACK)).toBe(500);
    expect(parseDuration("30s", FALLBACK)).toBe(30_000);
    expect(parseDuration("5m", FALLBACK)).toBe(300_000);
    expect(parseDuration("2h", FALLBACK)).toBe(7_200_000);
  });

  it("parses multi-unit durations", () => {
    expect(parseDuration("1h30m", FALLBACK)).toBe(5_400_000);
    expect(parseDuration("2h15m30s", FALLBACK)).toBe(8_130_000);
    expect(parseDuration("1 h 30 m", FALLBACK)).toBe(5_400_000);
  });

  it("falls back on unparseable input", () => {
    expect(parseDuration("", FALLBACK)).toBe(FALLBACK);
    expect(parseDuration("   ", FALLBACK)).toBe(FALLBACK);
    expect(parseDuration("zzz", FALLBACK)).toBe(FALLBACK);
    expect(parseDuration("1h30", FALLBACK)).toBe(FALLBACK);
    expect(parseDuration("5s!!", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects junk around the unit tokens instead of silently skipping it", () => {
    // The multi-unit scan is a global regex, so without a contiguity check it
    // skips any non-matching text and only verifies that the final match ends
    // at the end of the string.
    expect(parseDuration("abc5s", FALLBACK)).toBe(FALLBACK);
    expect(parseDuration("10gibberish5s", FALLBACK)).toBe(FALLBACK);
    expect(parseDuration("1h!30m", FALLBACK)).toBe(FALLBACK);
  });
});
