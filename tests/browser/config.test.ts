import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { CHATGPT_URL } from "../../src/browser/constants.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveBrowserConfig", () => {
  test("returns defaults when config missing", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.launcher).toBe("chrome");
    expect(resolved.url).toBe(CHATGPT_URL);
    const isWindows = process.platform === "win32";
    expect(resolved.cookieSync).toBe(!isWindows);
    expect(resolved.headless).toBe(false);
    expect(resolved.keepBrowser).toBe(false);
    expect(resolved.hideWindow).toBe(false);
    expect(resolved.manualLogin).toBe(isWindows);
    expect(resolved.profileLockTimeoutMs).toBe(300_000);
  });

  test("applies overrides", () => {
    const resolved = resolveBrowserConfig({
      url: "https://example.com",
      timeoutMs: 123,
      inputTimeoutMs: 456,
      cookieSync: false,
      headless: true,
      desiredModel: "Custom",
      chromeProfile: "Profile 1",
      chromePath: "/Applications/Chrome",
      debug: true,
    });
    expect(resolved.url).toBe("https://example.com/");
    expect(resolved.timeoutMs).toBe(123);
    expect(resolved.inputTimeoutMs).toBe(456);
    expect(resolved.cookieSync).toBe(false);
    expect(resolved.headless).toBe(true);
    expect(resolved.desiredModel).toBe("Custom");
    expect(resolved.chromeProfile).toBe("Profile 1");
    expect(resolved.chromePath).toBe("/Applications/Chrome");
    expect(resolved.debug).toBe(true);
  });

  test("resolves Browserbase config fields", () => {
    const resolved = resolveBrowserConfig({
      browserbase: {
        enabled: true,
        apiKey: "bb_api",
        projectId: "bb_project",
        contextId: "bb_context",
        persist: true,
        keepAlive: true,
        region: "eu-central-1",
        timeoutMs: 60_000,
        proxies: ["true"],
        stealth: true,
        captcha: true,
        viewport: { width: 1440, height: 900 },
      },
    });

    expect(resolved.browserbase).toEqual({
      enabled: true,
      apiKey: "bb_api",
      projectId: "bb_project",
      contextId: "bb_context",
      persist: true,
      keepAlive: true,
      region: "eu-central-1",
      timeoutMs: 60_000,
      proxies: ["true"],
      stealth: true,
      captcha: true,
      viewport: { width: 1440, height: 900 },
    });
  });

  test("merges Browserbase env config below explicit config", () => {
    vi.stubEnv("ORACLE_BROWSERBASE_ENABLED", "true");
    vi.stubEnv("BROWSERBASE_API_KEY", "env_api");
    vi.stubEnv("ORACLE_BROWSERBASE_PROJECT_ID", "env_project");
    vi.stubEnv("ORACLE_BROWSERBASE_REGION", "us-east-1");
    vi.stubEnv("ORACLE_BROWSERBASE_VIEWPORT", "1024x768");

    const resolved = resolveBrowserConfig({
      browserbase: {
        projectId: "explicit_project",
      },
    });

    expect(resolved.browserbase).toMatchObject({
      enabled: true,
      apiKey: "env_api",
      projectId: "explicit_project",
      region: "us-east-1",
      viewport: { width: 1024, height: 768 },
    });
  });

  test("rejects temporary chat URLs when desiredModel is Pro", () => {
    expect(() =>
      resolveBrowserConfig({
        url: "https://chatgpt.com/?temporary-chat=true",
        desiredModel: "GPT-5.2 Pro",
      }),
    ).toThrow(/Temporary Chat/i);
  });

  test("preserves manualLoginProfileDir as an attach-running hint", () => {
    const resolved = resolveBrowserConfig({
      attachRunning: true,
      manualLogin: false,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });

    expect(resolved.attachRunning).toBe(true);
    expect(resolved.manualLogin).toBe(false);
    expect(resolved.manualLoginProfileDir).toBe("/tmp/oracle-profile");
  });

  test("forces Carbonyl into its own non-hidden non-manual-login runtime", () => {
    const resolved = resolveBrowserConfig({
      launcher: "carbonyl",
      headless: true,
      hideWindow: true,
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });

    expect(resolved.launcher).toBe("carbonyl");
    expect(resolved.headless).toBe(false);
    expect(resolved.hideWindow).toBe(false);
    expect(resolved.manualLogin).toBe(false);
    expect(resolved.manualLoginProfileDir).toBeNull();
  });

  test("does not invent a profile hint for plain attach-running discovery", () => {
    const resolved = resolveBrowserConfig({
      attachRunning: true,
      manualLogin: false,
    });

    expect(resolved.attachRunning).toBe(true);
    expect(resolved.manualLogin).toBe(false);
    expect(resolved.manualLoginProfileDir).toBeNull();
  });
});
