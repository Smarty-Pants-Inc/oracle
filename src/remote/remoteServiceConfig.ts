import net from "node:net";
import { parseHostPort } from "../bridge/connection.js";

import type { UserConfig } from "../config.js";

export type RemoteServiceConfigSource = "cli" | "config.browser" | "env" | "unset";

export interface ResolvedRemoteServiceConfig {
  host?: string;
  token?: string;
  legacyToken?: string;
  allowLegacyTextProtocol: boolean;
  sources: {
    host: RemoteServiceConfigSource;
    token: RemoteServiceConfigSource;
    legacyToken: RemoteServiceConfigSource;
    allowLegacyTextProtocol: RemoteServiceConfigSource;
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

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
      return true;
    case "0":
    case "false":
    case "no":
      return false;
    default:
      return undefined;
  }
}

function resolveSource(
  cliValue: unknown,
  configValue: unknown,
  envValue: unknown,
): RemoteServiceConfigSource {
  if (cliValue !== undefined) return "cli";
  if (configValue !== undefined) return "config.browser";
  if (envValue !== undefined) return "env";
  return "unset";
}

export function resolveRemoteServiceConfig({
  cliHost,
  cliToken,
  cliLegacyToken,
  cliAllowLegacyTextProtocol,
  userConfig,
  env = process.env,
}: {
  cliHost?: string;
  cliToken?: string;
  cliLegacyToken?: string;
  cliAllowLegacyTextProtocol?: boolean;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}): ResolvedRemoteServiceConfig {
  const configBrowserHost = normalizeString(userConfig?.browser?.remoteHost);
  const configBrowserToken = normalizeString(userConfig?.browser?.remoteToken);
  const configBrowserLegacyToken = normalizeString(userConfig?.browser?.remoteLegacyToken);
  const configAllowLegacyTextProtocol = normalizeBoolean(
    userConfig?.browser?.remoteAllowLegacyTextProtocol,
  );

  const envHost = normalizeString(env.ORACLE_REMOTE_HOST);
  const envToken = normalizeString(env.ORACLE_REMOTE_TOKEN);
  const envLegacyToken = normalizeString(env.ORACLE_REMOTE_LEGACY_TOKEN);
  const envAllowLegacyTextProtocol = normalizeBoolean(env.ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL);

  const cliHostValue = normalizeString(cliHost);
  const cliTokenValue = normalizeString(cliToken);
  const cliLegacyTokenValue = normalizeString(cliLegacyToken);
  const cliAllowLegacyTextProtocolValue = normalizeBoolean(cliAllowLegacyTextProtocol);

  const host = cliHostValue ?? configBrowserHost ?? envHost;
  const token = cliTokenValue ?? configBrowserToken ?? envToken;
  const legacyToken = cliLegacyTokenValue ?? configBrowserLegacyToken ?? envLegacyToken;
  const allowLegacyTextProtocol =
    cliAllowLegacyTextProtocolValue ??
    configAllowLegacyTextProtocol ??
    envAllowLegacyTextProtocol ??
    false;

  if (host) parsePlaintextRemoteEndpoint(host);
  if (allowLegacyTextProtocol && token && legacyToken && token === legacyToken) {
    throw new Error(
      "Legacy text protocol requires a bearer credential distinct from the v3 HMAC root key.",
    );
  }

  return {
    host,
    token,
    legacyToken,
    allowLegacyTextProtocol,
    sources: {
      host: resolveSource(cliHostValue, configBrowserHost, envHost),
      token: resolveSource(cliTokenValue, configBrowserToken, envToken),
      legacyToken: resolveSource(cliLegacyTokenValue, configBrowserLegacyToken, envLegacyToken),
      allowLegacyTextProtocol: resolveSource(
        cliAllowLegacyTextProtocolValue,
        configAllowLegacyTextProtocol,
        envAllowLegacyTextProtocol,
      ),
    },
  };
}
