import { describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { enforceBrowserSearchFlag, exitAfterCliCompletion } from "../../bin/oracle-cli.js";
import type { RunOracleOptions } from "../../src/oracle.js";
import type { SessionMode } from "../../src/sessionStore.js";

const makeRunOptions = (search: boolean | undefined): RunOracleOptions => ({
  prompt: "hi",
  model: "gpt-5.1",
  file: [],
  search,
  heartbeatIntervalMs: 30000,
});

describe("browser search note", () => {
  it("logs note and clears search when browser + search=false", () => {
    const logSpy = vi.fn();
    const opts = makeRunOptions(false);
    enforceBrowserSearchFlag(opts, "browser" as SessionMode, logSpy);
    expect(logSpy).toHaveBeenCalledWith(
      chalk.dim("Note: search is not available in browser engine; ignoring search=false."),
    );
    expect(opts.search).toBeUndefined();
  });

  it("leaves search untouched for api", () => {
    const logSpy = vi.fn();
    const opts = makeRunOptions(false);
    enforceBrowserSearchFlag(opts, "api" as SessionMode, logSpy);
    expect(logSpy).not.toHaveBeenCalled();
    expect(opts.search).toBe(false);
  });

  it("forces one-shot CLI exit outside Vitest even when stdout is a TTY", async () => {
    const exitSpy = vi.fn();
    const stdout = {
      destroyed: false,
      write: vi.fn(() => true),
    } as unknown as NodeJS.WriteStream;
    const stderr = {
      destroyed: false,
      write: vi.fn(() => true),
    } as unknown as NodeJS.WriteStream;

    await exitAfterCliCompletion({
      isVitest: false,
      stdout,
      stderr,
      exitCode: 7,
      exit: exitSpy as never,
    });

    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  it("skips forced CLI exit under Vitest imports", async () => {
    const exitSpy = vi.fn();

    await exitAfterCliCompletion({
      isVitest: true,
      exit: exitSpy as never,
    });

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
