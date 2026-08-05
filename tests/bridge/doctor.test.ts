import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { PROJECT_CONFIG_RELATIVE_PATH } from "../../src/config.js";

// biome-ignore lint/complexity/useRegexLiterals: constructor form avoids control-char lint noise.
const ansiRegex = new RegExp("\\x1B\\[[0-9;]*m", "g");
const stripAnsi = (text: string): string => text.replace(ansiRegex, "");

vi.mock("../../src/remote/health.js", () => ({
  checkTcpConnection: vi.fn(async () => ({ ok: true })),
  checkRemoteHealth: vi.fn(async () => ({ ok: true, version: "test", uptimeSeconds: 1 })),
}));

vi.mock("../../src/browser/detect.js", () => ({
  detectChromeBinary: vi.fn(async () => ({ path: "/usr/bin/google-chrome" })),
  detectChromeCookieDb: vi.fn(async () => "/home/user/.config/google-chrome/Default/Cookies"),
}));

import { runBridgeDoctor } from "../../src/cli/bridge/doctor.js";
import { runBridgeClient } from "../../src/cli/bridge/client.js";

describe("oracle bridge doctor", () => {
  let tempDir: string;
  let originalExitCode: number | undefined;

  beforeEach(async () => {
    originalExitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
    process.exitCode = undefined;
    delete process.env.ORACLE_REMOTE_HOST;
    delete process.env.ORACLE_REMOTE_TOKEN;
    delete process.env.ORACLE_REMOTE_LEGACY_TOKEN;
    delete process.env.ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL;
    delete process.env.ORACLE_ENGINE;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-doctor-"));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    process.exitCode = originalExitCode;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports healthy remote configuration", async () => {
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({ browser: { remoteHost: "127.0.0.1:9473", remoteToken: "secret" } }, null, 2),
      "utf8",
    );

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    await runBridgeDoctor({ verbose: false });

    const output = stripAnsi(logs.join("\n"));
    expect(output).toMatch(/Remote service:\s+configured/i);
    expect(output).toMatch(/TCP connect:\s+ok/i);
    expect(output).toContain("Auth (/health):");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("accepts explicitly configured legacy-only remote compatibility", async () => {
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify(
        {
          browser: {
            remoteHost: "127.0.0.1:9473",
            remoteLegacyToken: "legacy-bearer",
            remoteAllowLegacyTextProtocol: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    await runBridgeDoctor({ verbose: false });

    const output = stripAnsi(logs.join("\n"));
    expect(output).toMatch(/remoteLegacyToken:\s+set/i);
    expect(output).toMatch(/legacy text fallback:\s+explicitly enabled/i);
    expect(output).not.toMatch(/Problems:/i);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("writes explicit legacy-only client config without reusing the bearer as a modern key", async () => {
    const configFile = path.join(tempDir, "legacy-client.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runBridgeClient({
      connect: "127.0.0.1:9473",
      legacyToken: "legacy-bearer",
      allowLegacyTextProtocol: true,
      config: configFile,
      test: false,
    });

    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    expect(config.browser).toMatchObject({
      remoteHost: "127.0.0.1:9473",
      remoteToken: null,
      remoteLegacyToken: "legacy-bearer",
      remoteAllowLegacyTextProtocol: true,
    });
  });

  it("refuses to reuse a modern connection token as the legacy bearer", async () => {
    await expect(
      runBridgeClient({
        connect: "127.0.0.1:9473?token=shared-credential",
        legacyToken: "shared-credential",
        allowLegacyTextProtocol: true,
        writeConfig: false,
        test: false,
      }),
    ).rejects.toThrow(/distinct from the v3 HMAC root key/i);
  });

  it("rejects non-loopback bridge artifacts even when the health check is skipped", async () => {
    await expect(
      runBridgeClient({
        connect: "oracle+tcp://bridge.example.test:9473?token=secret",
        writeConfig: false,
        test: false,
      }),
    ).rejects.toThrow(/loopback-only.*SSH tunnel/i);
  });

  it("fails when remote token is missing", async () => {
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({ browser: { remoteHost: "127.0.0.1:9473" } }, null, 2),
      "utf8",
    );

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    await runBridgeDoctor({ verbose: false });

    const output = stripAnsi(logs.join("\n"));
    expect(output).toMatch(/remoteToken:\s+missing/i);
    expect(output).toMatch(/Problems:/i);
    expect(process.exitCode).toBe(1);
  });

  it("reports project-only config separately from the missing user config", async () => {
    const originalCwd = process.cwd();
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-project-"));
    await fs.mkdir(path.join(repoDir, ".oracle"), { recursive: true });
    const projectConfigPath = path.join(repoDir, PROJECT_CONFIG_RELATIVE_PATH);
    await fs.writeFile(projectConfigPath, `{ engine: "browser" }`, "utf8");

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    try {
      process.chdir(repoDir);
      await runBridgeDoctor({ verbose: false });
    } finally {
      process.chdir(originalCwd);
      await fs.rm(repoDir, { recursive: true, force: true });
    }

    const output = stripAnsi(logs.join("\n"));
    expect(output).toContain(`Config: ${path.join(tempDir, "config.json")} (missing)`);
    expect(output).toMatch(
      /Project config: .*oracle-bridge-project-.*[\\/]\.oracle[\\/]config\.json/,
    );
    expect(output).toMatch(/Default engine:\s+browser/i);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
