import net from "node:net";
import { parseHostPort } from "../bridge/connection.js";

import type { UserConfig } from "../config.js";

export type RemoteServiceConfigSource = "cli" | "config.browser" | "env" | "unset";

export interface ResolvedRemoteServiceConfig {
  host?: string;
  token?: string;
  sources: {
    host: RemoteServiceConfigSource;
    token: RemoteServiceConfigSource;
  };
}

export const REMOTE_PLAINTEXT_TRANSPORT_GUIDANCE =
  "Plaintext Oracle remote transport is loopback-only. Bind oracle serve to 127.0.0.1 or ::1 and connect through an SSH tunnel that exposes a loopback endpoint. Direct non-loopback transport requires verified TLS, which this client does not currently implement.";

export function isLoopbackRemoteHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (net.isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }
  const mappedIpv4 = /^::ffff:(127(?:\.\d{1,3}){3})$/.exec(normalized)?.[1];
  return Boolean(mappedIpv4 && net.isIP(mappedIpv4) === 4);
}

export function parsePlaintextRemoteEndpoint(input: string): { hostname: string; port: number } {
  const endpoint = parseHostPort(input);
  if (!isLoopbackRemoteHostname(endpoint.hostname)) {
    throw new Error(`${REMOTE_PLAINTEXT_TRANSPORT_GUIDANCE} Refused endpoint: ${input}.`);
  }
  return endpoint;
}

export function assertLoopbackRemoteBind(hostname: string): void {
  if (!isLoopbackRemoteHostname(hostname)) {
    throw new Error(`${REMOTE_PLAINTEXT_TRANSPORT_GUIDANCE} Refused bind address: ${hostname}.`);
  }
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function resolveRemoteServiceConfig({
  cliHost,
  cliToken,
  userConfig,
  env = process.env,
}: {
  cliHost?: string;
  cliToken?: string;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}): ResolvedRemoteServiceConfig {
  const configBrowserHost = normalizeString(userConfig?.browser?.remoteHost);
  const configBrowserToken = normalizeString(userConfig?.browser?.remoteToken);

  const envHost = normalizeString(env.ORACLE_REMOTE_HOST);
  const envToken = normalizeString(env.ORACLE_REMOTE_TOKEN);

  const cliHostValue = normalizeString(cliHost);
  const cliTokenValue = normalizeString(cliToken);

  const host = cliHostValue ?? configBrowserHost ?? envHost;
  const token = cliTokenValue ?? configBrowserToken ?? envToken;

  const hostSource: RemoteServiceConfigSource = cliHostValue
    ? "cli"
    : configBrowserHost
      ? "config.browser"
      : envHost
        ? "env"
        : "unset";

  const tokenSource: RemoteServiceConfigSource = cliTokenValue
    ? "cli"
    : configBrowserToken
      ? "config.browser"
      : envToken
        ? "env"
        : "unset";

  if (host) parsePlaintextRemoteEndpoint(host);
  return { host, token, sources: { host: hostSource, token: tokenSource } };
}
