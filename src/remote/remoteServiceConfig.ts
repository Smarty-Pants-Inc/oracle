import net from "node:net";
import { assertCurrentRemoteCredential, parseHostPort } from "../bridge/connection.js";

import type { UserConfig } from "../config.js";

export type RemoteServiceConfigSource = "cli" | "env" | "config.browser" | "unset";

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

function normalizeCredential(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
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
  envValue: unknown,
  configValue: unknown,
): RemoteServiceConfigSource {
  if (cliValue !== undefined) return "cli";
  if (envValue !== undefined) return "env";
  if (configValue !== undefined) return "config.browser";
  return "unset";
}

export function validateResolvedRemoteServiceConfig(
  resolved: ResolvedRemoteServiceConfig,
): ResolvedRemoteServiceConfig {
  if (resolved.host) parsePlaintextRemoteEndpoint(resolved.host);
  if (resolved.token !== undefined) {
    assertCurrentRemoteCredential(
      resolved.token,
      `Remote v3 HMAC root key from ${resolved.sources.token}`,
    );
  }
  if (resolved.legacyToken !== undefined) {
    assertCurrentRemoteCredential(
      resolved.legacyToken,
      `Remote legacy bearer credential from ${resolved.sources.legacyToken}`,
    );
  }
  if (
    resolved.allowLegacyTextProtocol &&
    resolved.token &&
    resolved.legacyToken &&
    resolved.token === resolved.legacyToken
  ) {
    throw new Error(
      "Legacy text protocol requires a bearer credential distinct from the v3 HMAC root key.",
    );
  }
  return resolved;
}

export function resolveRemoteServiceConfig({
  cliHost,
  cliToken,
  cliLegacyToken,
  cliAllowLegacyTextProtocol,
  userConfig,
  env = process.env,
  validate = true,
}: {
  cliHost?: string;
  cliToken?: string;
  cliLegacyToken?: string;
  cliAllowLegacyTextProtocol?: boolean;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
  validate?: boolean;
}): ResolvedRemoteServiceConfig {
  const configBrowserHost = normalizeString(userConfig?.browser?.remoteHost);
  const configBrowserToken = normalizeCredential(userConfig?.browser?.remoteToken);
  const configBrowserLegacyToken = normalizeCredential(userConfig?.browser?.remoteLegacyToken);
  const configAllowLegacyTextProtocol = normalizeBoolean(
    userConfig?.browser?.remoteAllowLegacyTextProtocol,
  );

  const envHost = normalizeString(env.ORACLE_REMOTE_HOST);
  const envToken = normalizeCredential(env.ORACLE_REMOTE_TOKEN);
  const envLegacyToken = normalizeCredential(env.ORACLE_REMOTE_LEGACY_TOKEN);
  const envAllowLegacyTextProtocol = normalizeBoolean(env.ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL);

  const cliHostValue = normalizeString(cliHost);
  const cliTokenValue = normalizeCredential(cliToken);
  const cliLegacyTokenValue = normalizeCredential(cliLegacyToken);
  const cliAllowLegacyTextProtocolValue = normalizeBoolean(cliAllowLegacyTextProtocol);

  const host = cliHostValue ?? envHost ?? configBrowserHost;
  const token = cliTokenValue ?? envToken ?? configBrowserToken;
  const legacyToken = cliLegacyTokenValue ?? envLegacyToken ?? configBrowserLegacyToken;
  const allowLegacyTextProtocol =
    cliAllowLegacyTextProtocolValue ??
    envAllowLegacyTextProtocol ??
    configAllowLegacyTextProtocol ??
    false;

  const resolved: ResolvedRemoteServiceConfig = {
    host,
    token,
    legacyToken,
    allowLegacyTextProtocol,
    sources: {
      host: resolveSource(cliHostValue, envHost, configBrowserHost),
      token: resolveSource(cliTokenValue, envToken, configBrowserToken),
      legacyToken: resolveSource(cliLegacyTokenValue, envLegacyToken, configBrowserLegacyToken),
      allowLegacyTextProtocol: resolveSource(
        cliAllowLegacyTextProtocolValue,
        envAllowLegacyTextProtocol,
        configAllowLegacyTextProtocol,
      ),
    },
  };
  return validate ? validateResolvedRemoteServiceConfig(resolved) : resolved;
}
