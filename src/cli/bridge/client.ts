import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { configPath as defaultConfigPath } from "../../config.js";
import type { UserConfig } from "../../config.js";
import {
  normalizeHostPort,
  parseBridgeConnectionString,
  readBridgeConnectionArtifact,
  looksLikePath,
} from "../../bridge/connection.js";
import type { BridgeTunnelInfo } from "../../bridge/connection.js";
import {
  readUserConfigFile,
  writeUserConfigFile,
  type UserConfigFileAuthorities,
} from "../../bridge/userConfigFile.js";
import { checkRemoteHealth } from "../../remote/health.js";
import { assertRemoteCredential } from "../../remote/auth.js";
import { parsePlaintextRemoteEndpoint } from "../../remote/remoteServiceConfig.js";

export interface BridgeClientCliOptions {
  connect?: string;
  writeConfig?: boolean;
  config?: string;
  test?: boolean;
  printEnv?: boolean;
  legacyToken?: string;
  allowLegacyTextProtocol?: boolean;
}

export interface BridgeClientCliDeps {
  readonly userConfigFileAuthorities?: UserConfigFileAuthorities;
}

export async function runBridgeClient(
  options: BridgeClientCliOptions,
  deps: BridgeClientCliDeps = {},
): Promise<void> {
  const connectRaw = options.connect;
  if (!connectRaw) {
    throw new Error(
      "Missing --connect. Provide a connection string or a bridge-connection.json path.",
    );
  }

  const allowLegacyTextProtocol = options.allowLegacyTextProtocol === true;
  const explicitLegacyToken = options.legacyToken;
  if (allowLegacyTextProtocol && explicitLegacyToken === undefined) {
    throw new Error(
      "--allow-legacy-text-protocol requires a distinct --legacy-token; connection tokens are never reused as legacy bearers.",
    );
  }
  if (explicitLegacyToken !== undefined && !allowLegacyTextProtocol) {
    throw new Error("--legacy-token requires explicit --allow-legacy-text-protocol opt-in.");
  }
  const { remoteHost, remoteToken, tunnel } = await resolveConnection(connectRaw, {
    allowTokenless: allowLegacyTextProtocol,
  });
  parsePlaintextRemoteEndpoint(remoteHost);
  const token =
    remoteToken === undefined
      ? undefined
      : assertRemoteCredential(remoteToken, "Bridge connection token");
  const legacyToken =
    allowLegacyTextProtocol && explicitLegacyToken !== undefined
      ? assertRemoteCredential(explicitLegacyToken, "Bridge client --legacy-token")
      : undefined;
  if (token && legacyToken && token === legacyToken) {
    throw new Error(
      "Legacy text protocol requires a bearer credential distinct from the v3 HMAC root key.",
    );
  }

  if (options.test !== false) {
    const health = await checkRemoteHealth({
      host: remoteHost,
      token,
      legacyToken,
      allowLegacyTextProtocol,
      timeoutMs: 5000,
    });
    if (!health.ok) {
      const suffix = health.statusCode ? ` (HTTP ${health.statusCode})` : "";
      throw new Error(
        `Remote service health check failed: ${health.error ?? "unknown error"}${suffix}`,
      );
    }
    const artifactTransfer = health.capabilities?.artifactTransfer
      ? ` — artifacts bridge v${health.capabilities.artifactProtocolVersion}`
      : " — artifact transfer unavailable; file downloads require manual copy";
    console.log(
      chalk.green(
        `Remote service OK (${remoteHost})${health.version ? ` — oracle ${health.version}` : ""}${artifactTransfer}`,
      ),
    );
  }

  const configuredPath = options.config?.trim();
  const configFilePath = configuredPath ? path.resolve(configuredPath) : defaultConfigPath();
  if (options.writeConfig !== false) {
    const { config } = await readUserConfigFile(configFilePath, deps.userConfigFileAuthorities);
    const next: UserConfig = { ...config, browser: { ...config.browser } };
    next.browser = { ...next.browser };
    next.browser.remoteHost = remoteHost;
    next.browser.remoteToken = token ?? null;
    next.browser.remoteLegacyToken = legacyToken ?? null;
    next.browser.remoteAllowLegacyTextProtocol = allowLegacyTextProtocol;
    if (tunnel) {
      next.browser.remoteViaSshReverseTunnel = {
        ssh: tunnel.ssh,
        remotePort: tunnel.remotePort,
        localPort: tunnel.localPort,
        identity: tunnel.identity,
        extraArgs: tunnel.extraArgs,
      };
    }
    await writeUserConfigFile(configFilePath, next, deps.userConfigFileAuthorities);
    console.log(chalk.green(`Wrote remote config to ${configFilePath}`));
  }

  console.log("");
  console.log("Next:");
  console.log(chalk.dim(`- oracle --engine browser -p "hello" --file README.md`));

  if (options.printEnv) {
    console.log("");
    console.log("# Optional env overrides (paste into your shell):");
    console.log(`export ORACLE_ENGINE=browser`);
    console.log(`export ORACLE_REMOTE_HOST=${shellQuote(remoteHost)}`);
    if (token) console.log(`export ORACLE_REMOTE_TOKEN=${shellQuote(token)}`);
    if (allowLegacyTextProtocol && legacyToken) {
      console.log(`export ORACLE_REMOTE_LEGACY_TOKEN=${shellQuote(legacyToken)}`);
      console.log("export ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL=1");
    }
  }
}

async function resolveConnection(
  input: string,
  options: { allowTokenless?: boolean } = {},
): Promise<{ remoteHost: string; remoteToken?: string; tunnel?: BridgeTunnelInfo }> {
  if (input !== input.trim()) {
    throw new Error(
      "Invalid connection string or artifact path: surrounding whitespace is not allowed.",
    );
  }
  if (
    options.allowTokenless &&
    (input.includes("://") || !looksLikePath(input)) &&
    !/[?&]token=/.test(input)
  ) {
    let url: URL;
    try {
      url = input.includes("://") ? new URL(input) : new URL(`oracle+tcp://${input}`);
    } catch (error) {
      throw new Error(
        `Invalid connection string: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const hostname = url.hostname?.trim();
    const port = Number.parseInt(url.port ?? "", 10);
    if (!hostname || !Number.isFinite(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid connection string host: ${input}. Expected host:port.`);
    }
    return { remoteHost: normalizeHostPort(hostname, port) };
  }

  if (input.includes("://")) {
    return { ...parseBridgeConnectionString(input) };
  }

  const resolvedPath = looksLikePath(input) ? path.resolve(process.cwd(), input) : null;
  if (resolvedPath) {
    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (stat?.isFile()) {
      const artifact = await readBridgeConnectionArtifact(resolvedPath);
      return {
        remoteHost: artifact.remoteHost,
        remoteToken: artifact.remoteToken,
        tunnel: artifact.tunnel,
      };
    }
    if (stat) {
      throw new Error(`--connect points to ${resolvedPath}, but it is not a file.`);
    }
    throw new Error(`Connection artifact not found at ${resolvedPath}`);
  }

  return { ...parseBridgeConnectionString(input) };
}

function shellQuote(value: string): string {
  // Single-quote for POSIX shells; safe for tokens/host strings.
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
