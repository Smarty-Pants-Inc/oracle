import chalk from "chalk";
import { loadUserConfig } from "../../config.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";

export interface BridgeCodexConfigCliOptions {
  printToken?: boolean;
}

export async function runBridgeCodexConfig(options: BridgeCodexConfigCliOptions): Promise<void> {
  const { config: userConfig } = await loadUserConfig();
  const resolved = resolveRemoteServiceConfig({
    cliHost: undefined,
    cliToken: undefined,
    userConfig,
    env: process.env,
  });

  const snippet = formatCodexMcpSnippet({
    remoteHost: resolved.host,
    remoteToken: resolved.token,
    remoteLegacyToken: resolved.legacyToken,
    allowLegacyTextProtocol: resolved.allowLegacyTextProtocol,
    includeToken: Boolean(options.printToken),
  });

  console.log(snippet);
  if (!options.printToken) {
    console.error("");
    console.error(
      chalk.dim("Tip: rerun with --print-token to include configured remote token(s)."),
    );
  }
}

export function formatCodexMcpSnippet({
  remoteHost,
  remoteToken,
  remoteLegacyToken,
  allowLegacyTextProtocol = false,
  includeToken,
}: {
  remoteHost?: string;
  remoteToken?: string;
  remoteLegacyToken?: string;
  allowLegacyTextProtocol?: boolean;
  includeToken: boolean;
}): string {
  const hostValue = remoteHost ?? "127.0.0.1:9473";
  const envEntries = [
    `ORACLE_ENGINE = "browser"`,
    `ORACLE_REMOTE_HOST = "${escapeTomlString(hostValue)}"`,
  ];
  if (remoteToken || !allowLegacyTextProtocol) {
    const tokenValue = includeToken
      ? (remoteToken ?? "<64_LOWERCASE_HEX_CHARACTERS>")
      : "<64_LOWERCASE_HEX_CHARACTERS>";
    envEntries.push(`ORACLE_REMOTE_TOKEN = "${escapeTomlString(tokenValue)}"`);
  }
  if (allowLegacyTextProtocol) {
    const legacyTokenValue = includeToken
      ? (remoteLegacyToken ?? "<DISTINCT_64_LOWERCASE_HEX_CHARACTERS>")
      : "<DISTINCT_64_LOWERCASE_HEX_CHARACTERS>";
    envEntries.push(
      `ORACLE_REMOTE_LEGACY_TOKEN = "${escapeTomlString(legacyTokenValue)}"`,
      `ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL = "1"`,
    );
  }
  const envValue = envEntries.join(", ");

  return [
    "# ~/.codex/config.toml",
    "",
    "[mcp.servers.oracle]",
    'command = "oracle-mcp"',
    "args = []",
    `env = { ${envValue} }`,
    "",
    "# If you prefer npx:",
    "# [mcp.servers.oracle]",
    '# command = "npx"',
    '# args = ["-y", "@steipete/oracle", "oracle-mcp"]',
    `# env = { ${envValue} }`,
  ].join("\n");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
