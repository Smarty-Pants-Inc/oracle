import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, afterEach } from "vitest";
import { buildBrowserConfig } from "../../src/cli/browserConfig.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const model = "gpt-5.4" as const;

describe("buildBrowserConfig inline cookies", () => {
  afterEach(() => {
    setOracleHomeDirOverrideForTest(null);
    delete process.env.ORACLE_BROWSER_COOKIES_JSON;
    delete process.env.ORACLE_BROWSER_COOKIES_FILE;
  });

  test("loads inline cookies from explicit file flag", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-inline-"));
    try {
      const file = path.join(tmp, "cookies.json");
      await fs.writeFile(
        file,
        JSON.stringify([
          { name: "__Secure-next-auth.session-token", value: "abc", domain: "chatgpt.com" },
        ]),
      );
      const config = await buildBrowserConfig({ browserInlineCookiesFile: file, model });
      expect(config.inlineCookies?.[0]?.name).toBe("__Secure-next-auth.session-token");
      expect(config.inlineCookiesSource).toBe("inline-file");
      expect(config.cookieSync).toBe(true);
      expect(config.manualLoginCookieSync).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("treats inline payload value as file path when it exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-inline-arg-"));
    try {
      const file = path.join(tmp, "cookies.json");
      await fs.writeFile(
        file,
        JSON.stringify([{ name: "_account", value: "personal", domain: "chatgpt.com" }]),
      );
      const config = await buildBrowserConfig({ browserInlineCookies: file, model });
      expect(config.inlineCookies?.[0]?.name).toBe("_account");
      expect(config.inlineCookiesSource).toBe("inline-arg");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("uses ~/.oracle/cookies.json when Chrome cookie copy is not enabled", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
    const oracleDir = path.join(fakeHome, ".oracle");
    setOracleHomeDirOverrideForTest(oracleDir);
    await fs.mkdir(oracleDir, { recursive: true });
    const homeFile = path.join(oracleDir, "cookies.json");
    await fs.writeFile(
      homeFile,
      JSON.stringify([{ name: "cf_clearance", value: "token", domain: "chatgpt.com" }]),
    );
    const config = await buildBrowserConfig({ model });
    expect(config.inlineCookies?.[0]?.name).toBe("cf_clearance");
    expect(config.inlineCookiesSource).toBe("home:cookies.json");
    expect(config.cookieSync).toBe(true);
  });

  test("prefers explicit Chrome cookie copy over ~/.oracle/cookies.json", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
    const oracleDir = path.join(fakeHome, ".oracle");
    setOracleHomeDirOverrideForTest(oracleDir);
    await fs.mkdir(oracleDir, { recursive: true });
    const homeFile = path.join(oracleDir, "cookies.json");
    await fs.writeFile(
      homeFile,
      JSON.stringify([{ name: "cf_clearance", value: "token", domain: "chatgpt.com" }]),
    );
    const config = await buildBrowserConfig({ model, browserCookieSync: true });
    expect(config.inlineCookies).toBeUndefined();
    expect(config.inlineCookiesSource).toBeNull();
    expect(config.cookieSync).toBe(true);
  });

  test("uses ~/.oracle/cookies.json with the legacy no-copy flag", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
    const oracleDir = path.join(fakeHome, ".oracle");
    setOracleHomeDirOverrideForTest(oracleDir);
    await fs.mkdir(oracleDir, { recursive: true });
    await fs.writeFile(
      path.join(oracleDir, "cookies.json"),
      JSON.stringify([{ name: "cf_clearance", value: "token", domain: "chatgpt.com" }]),
    );
    const config = await buildBrowserConfig({ model, browserNoCookieSync: true });
    expect(config.inlineCookies?.[0]?.name).toBe("cf_clearance");
    expect(config.inlineCookiesSource).toBe("home:cookies.json");
    expect(config.cookieSync).toBe(true);
  });
});
