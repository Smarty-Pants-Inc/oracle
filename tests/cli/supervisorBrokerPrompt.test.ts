import { describe, expect, test } from "vitest";
import { buildSupervisorBrowserConfig } from "../../src/cli/supervisorBrokerPrompt.ts";

describe("buildSupervisorBrowserConfig", () => {
  test("defaults hidden supervisor runs to a reusable manual-login profile with cookie sync", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginCookieSync: true,
      cookieSync: true,
      keepBrowser: true,
      attachRunning: false,
      desiredModel: "GPT-5.4 Pro",
    });
  });

  test("respects an explicit opt-out from manual-login cookie sync", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          manualLoginCookieSync: false,
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginCookieSync: false,
      cookieSync: false,
      keepBrowser: true,
    });
  });

  test("preserves a configured manual-login profile when supervisor forces manual login", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {
        browser: {
          manualLogin: false,
          manualLoginProfileDir: "/tmp/oracle-supervisor-profile",
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: true,
    });

    expect(config.manualLoginProfileDir).toBe("/tmp/oracle-supervisor-profile");
  });

  test("does not force local macOS cookie-sync defaults onto remote browser hosts", () => {
    const config = buildSupervisorBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      defaultManualLoginCookieSync: false,
    });

    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginCookieSync: false,
      cookieSync: false,
      keepBrowser: true,
    });
  });
});
