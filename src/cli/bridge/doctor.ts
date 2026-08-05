import os from "node:os";
import chalk from "chalk";
import { getCliVersion } from "../../version.js";
import { loadUserConfig } from "../../config.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import { checkTcpConnection, checkRemoteHealth } from "../../remote/health.js";
import { detectChromeBinary, detectChromeCookieDb } from "../../browser/detect.js";
import { formatCodexMcpSnippet } from "./codexConfig.js";

export interface BridgeDoctorCliOptions {
  verbose?: boolean;
}

export async function runBridgeDoctor(_options: BridgeDoctorCliOptions): Promise<void> {
  const {
    config: userConfig,
    path: configPath,
    paths: configPaths,
    loaded: userConfigLoaded,
  } = await loadUserConfig();
  const version = getCliVersion();
  const projectConfigPaths = configPaths.filter((entry) => entry !== configPath);

  const resolvedRemote = resolveRemoteServiceConfig({
    cliHost: undefined,
    cliToken: undefined,
    userConfig,
    env: process.env,
  });

  const lines: string[] = [];
  const fail: string[] = [];
  const warn: string[] = [];

  lines.push(chalk.bold("Bridge doctor"));
  lines.push(chalk.dim(`OS: ${process.platform} ${os.release()} (${process.arch})`));
  lines.push(chalk.dim(`Node: ${process.version}`));
  lines.push(chalk.dim(`Oracle: ${version}`));
  lines.push(chalk.dim(`Config: ${userConfigLoaded ? configPath : `${configPath} (missing)`}`));
  if (projectConfigPaths.length > 0) {
    const label = projectConfigPaths.length === 1 ? "Project config" : "Project configs";
    lines.push(chalk.dim(`${label}: ${projectConfigPaths.join(", ")}`));
  }
  if (userConfig.engine) {
    lines.push(chalk.dim(`Default engine: ${userConfig.engine}`));
  }
  if (userConfig.model) {
    lines.push(chalk.dim(`Default model: ${userConfig.model}`));
  }

  lines.push("");
  lines.push(chalk.bold("Browser mode"));

  if (resolvedRemote.host) {
    lines.push(`Remote service: ${chalk.green("configured")}`);
    lines.push(chalk.dim(`remoteHost: ${resolvedRemote.host} (${resolvedRemote.sources.host})`));
    lines.push(
      chalk.dim(
        `remoteToken: ${resolvedRemote.token ? "set" : "missing"} (${resolvedRemote.sources.token})`,
      ),
    );
    lines.push(
      chalk.dim(
        `remoteLegacyToken: ${resolvedRemote.legacyToken ? "set" : "missing"} (${resolvedRemote.sources.legacyToken})`,
      ),
    );
    lines.push(
      chalk.dim(
        `legacy text fallback: ${resolvedRemote.allowLegacyTextProtocol ? "explicitly enabled" : "disabled"} (${resolvedRemote.sources.allowLegacyTextProtocol})`,
      ),
    );

    const tcp = await checkTcpConnection(resolvedRemote.host, 2000);
    if (tcp.ok) {
      lines.push(chalk.dim(`TCP connect: ${chalk.green("ok")}`));
    } else {
      fail.push(`Cannot reach ${resolvedRemote.host} (${tcp.error ?? "unknown error"}).`);
      lines.push(
        chalk.dim(`TCP connect: ${chalk.red(`failed (${tcp.error ?? "unknown error"})`)}`),
      );
    }

    const hasUsableCredential =
      Boolean(resolvedRemote.token) ||
      Boolean(resolvedRemote.allowLegacyTextProtocol && resolvedRemote.legacyToken);
    if (!hasUsableCredential) {
      fail.push(
        "Remote credential is missing. Configure ORACLE_REMOTE_TOKEN for v3, or explicitly opt into predecessor text-only compatibility with ORACLE_REMOTE_LEGACY_TOKEN and ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL=1.",
      );
    } else if (tcp.ok) {
      const health = await checkRemoteHealth({
        host: resolvedRemote.host,
        token: resolvedRemote.token,
        legacyToken: resolvedRemote.legacyToken,
        allowLegacyTextProtocol: resolvedRemote.allowLegacyTextProtocol,
        timeoutMs: 5000,
      });
      if (health.ok) {
        const meta = health.version ? `oracle ${health.version}` : "ok";
        lines.push(chalk.dim(`Auth (/health): ${chalk.green(meta)}`));
        lines.push(chalk.dim(`Negotiated protocol: ${chalk.green(health.protocol ?? "unknown")}`));
        if (health.capabilities?.artifactTransfer) {
          lines.push(
            chalk.dim(
              `Artifact transfer: ${chalk.green(`bridge v${health.capabilities.artifactProtocolVersion}`)} (${formatBytes(health.capabilities.maxArtifactBytes)} max)`,
            ),
          );
        } else {
          warn.push(
            "Remote host does not advertise bridge artifact transfer; ChatGPT-generated files may need manual copy from the browser host.",
          );
          lines.push(chalk.dim(`Artifact transfer: ${chalk.yellow("manual fallback")}`));
        }
      } else {
        const detail = health.error ?? "unknown error";
        fail.push(`Remote auth failed: ${detail}`);
        const suffix = health.statusCode ? `HTTP ${health.statusCode}` : "network";
        lines.push(chalk.dim(`Auth (/health): ${chalk.red(`${suffix} (${detail})`)}`));
      }
    }
  } else {
    lines.push(`Remote service: ${chalk.yellow("not configured")}`);
    const chrome = await detectChromeBinary();
    if (chrome.path) {
      lines.push(chalk.dim(`Chrome: ${chalk.green(chrome.path)}`));
    } else {
      fail.push(
        "No Chrome installation detected. Install Chrome/Chromium or set --browser-chrome-path.",
      );
      lines.push(chalk.dim(`Chrome: ${chalk.red("not found")}`));
    }

    if (process.platform === "win32") {
      warn.push(
        "Cookie sync is disabled on Windows; use --browser-manual-login or run browser automation on another host.",
      );
      lines.push(chalk.dim("Cookies: (cookie sync disabled on Windows)"));
    } else {
      const cookieDb = await detectChromeCookieDb({ profile: "Default" });
      if (cookieDb) {
        lines.push(chalk.dim(`Cookies DB: ${chalk.green(cookieDb)}`));
      } else {
        warn.push(
          "Chrome cookies DB not detected. You may need --browser-cookie-path or --browser-manual-login.",
        );
        lines.push(chalk.dim(`Cookies DB: ${chalk.yellow("not found")}`));
      }
    }
  }

  lines.push("");
  lines.push(chalk.bold("Codex MCP"));
  lines.push(
    formatCodexMcpSnippet({
      remoteHost: resolvedRemote.host,
      remoteToken: resolvedRemote.token,
      remoteLegacyToken: resolvedRemote.legacyToken,
      allowLegacyTextProtocol: resolvedRemote.allowLegacyTextProtocol,
      includeToken: false,
    }),
  );

  if (warn.length) {
    lines.push("");
    lines.push(chalk.yellowBright("Warnings:"));
    for (const message of warn) {
      lines.push(chalk.yellow(`- ${message}`));
    }
  }
  if (fail.length) {
    lines.push("");
    lines.push(chalk.redBright("Problems:"));
    for (const message of fail) {
      lines.push(chalk.red(`- ${message}`));
    }
  }

  console.log(lines.join("\n"));

  process.exitCode = fail.length ? 1 : 0;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
