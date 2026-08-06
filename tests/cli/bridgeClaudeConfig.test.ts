import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { formatClaudeMcpConfig } from "../../src/cli/bridge/claudeConfig.ts";
import { formatCodexMcpSnippet } from "../../src/cli/bridge/codexConfig.ts";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");

const MODERN_TOKEN = "a".repeat(64);
const LEGACY_TOKEN = "b".repeat(64);

describe("formatClaudeMcpConfig", () => {
  test("prints a remote Claude Code MCP config without exposing tokens by default", () => {
    const parsed = JSON.parse(
      formatClaudeMcpConfig({
        oracleHomeDir: "/Users/test/.oracle-local",
        browserProfileDir: "/Users/test/.oracle-local/browser-profile",
        remoteHost: "127.0.0.1:9473",
        remoteToken: MODERN_TOKEN,
        includeToken: false,
      }),
    );

    expect(parsed.mcpServers.oracle).toMatchObject({
      type: "stdio",
      command: "oracle-mcp",
      args: [],
    });
    expect(parsed.mcpServers.oracle.env).toMatchObject({
      ORACLE_ENGINE: "browser",
      ORACLE_HOME_DIR: "/Users/test/.oracle-local",
      ORACLE_BROWSER_PROFILE_DIR: "/Users/test/.oracle-local/browser-profile",
      ORACLE_REMOTE_HOST: "127.0.0.1:9473",
      ORACLE_REMOTE_TOKEN: "<64_LOWERCASE_HEX_CHARACTERS>",
    });
  });

  test("prints explicit legacy-only MCP credentials without inventing a modern bearer", () => {
    const parsed = JSON.parse(
      formatClaudeMcpConfig({
        oracleHomeDir: "/Users/test/.oracle-local",
        browserProfileDir: "/Users/test/.oracle-local/browser-profile",
        remoteHost: "127.0.0.1:9473",
        remoteLegacyToken: LEGACY_TOKEN,
        allowLegacyTextProtocol: true,
        includeToken: false,
      }),
    );

    expect(parsed.mcpServers.oracle.env).toMatchObject({
      ORACLE_REMOTE_HOST: "127.0.0.1:9473",
      ORACLE_REMOTE_LEGACY_TOKEN: "<DISTINCT_64_LOWERCASE_HEX_CHARACTERS>",
      ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL: "1",
    });
    expect(parsed.mcpServers.oracle.env).not.toHaveProperty("ORACLE_REMOTE_TOKEN");

    const codex = formatCodexMcpSnippet({
      remoteHost: "127.0.0.1:9473",
      remoteLegacyToken: LEGACY_TOKEN,
      allowLegacyTextProtocol: true,
      includeToken: true,
    });
    expect(codex).toContain(`ORACLE_REMOTE_LEGACY_TOKEN = "${LEGACY_TOKEN}"`);
    expect(codex).toContain('ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL = "1"');
    expect(codex).not.toContain("ORACLE_REMOTE_TOKEN =");
  });

  test("prints a local-browser Claude Code MCP config without remote bridge env", () => {
    const parsed = JSON.parse(
      formatClaudeMcpConfig({
        oracleHomeDir: "/Users/test/.oracle",
        browserProfileDir: "/Users/test/.oracle/browser-profile",
        remoteHost: "127.0.0.1:9473",
        remoteToken: MODERN_TOKEN,
        includeToken: true,
        localBrowser: true,
      }),
    );

    expect(parsed.mcpServers.oracle.env).toEqual({
      ORACLE_ENGINE: "browser",
      ORACLE_HOME_DIR: "/Users/test/.oracle",
      ORACLE_BROWSER_PROFILE_DIR: "/Users/test/.oracle/browser-profile",
    });
  });

  test("rejects malformed remote credentials at CLI boundaries", async () => {
    for (const token of ["dictionary-word", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      await expect(
        execFileAsync(process.execPath, ["--import", "tsx", CLI_ENTRY, "serve", "--token", token]),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(/exactly 64 lowercase hexadecimal characters \(32 bytes\)/i),
      });
    }
    await expect(
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        CLI_ENTRY,
        "serve",
        "--token",
        MODERN_TOKEN,
        "--legacy-token",
        "weak",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/exactly 64 lowercase hexadecimal characters \(32 bytes\)/i),
    });
    for (const args of [
      ["--remote-host", "127.0.0.1:9473", "--remote-token", "weak"],
      [
        "--remote-host",
        "127.0.0.1:9473",
        "--remote-legacy-token",
        "weak",
        "--allow-legacy-text-protocol",
      ],
    ]) {
      await expect(
        execFileAsync(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args]),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(/exactly 64 lowercase hexadecimal characters \(32 bytes\)/i),
      });
    }
  }, 30_000);

  test("prints local-browser CLI config as parseable stdout JSON", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-claude-config-"));
    const browserProfileDir = path.join(oracleHome, "browser-profile");
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "bridge", "claude-config", "--local-browser"],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=DEP0205"]
              .filter(Boolean)
              .join(" "),
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_HOME_DIR: oracleHome,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_BROWSER_PROFILE_DIR: browserProfileDir,
          },
        },
      );

      const parsed = JSON.parse(stdout);
      expect(stderr.trim()).toBe("");
      expect(parsed.mcpServers.oracle.env).toEqual({
        ORACLE_ENGINE: "browser",
        ORACLE_HOME_DIR: oracleHome,
        ORACLE_BROWSER_PROFILE_DIR: browserProfileDir,
      });
    } finally {
      await rm(oracleHome, { recursive: true, force: true });
    }
  }, 15_000);
});
