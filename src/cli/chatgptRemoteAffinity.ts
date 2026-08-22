import { bindRemoteChromeBrowserWebSocketEndpoint } from "../browser/profileState.js";

export const CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV = "ORACLE_WRAPPER_CHATGPT_ACCOUNT_BOUND";

export interface ChatGptRemoteAffinityCliOptions {
  remoteChrome?: string;
  remoteChromeBrowserId?: string;
  remoteChromeBrowserWs?: string;
  remoteChromeAccountDigest?: string;
  expectedEmail?: string;
}

export interface ChatGptRemoteEmailAffinity {
  host: string;
  port: number;
  browserId: string;
  browserWSEndpoint: string;
  expectedEmail: string;
}

export interface ChatGptRemoteAccountAffinity extends ChatGptRemoteEmailAffinity {
  accountDigest: string;
}

export function parseRemoteChromeTarget(raw: string): { host: string; port: number } {
  const target = raw.trim();
  if (!target) {
    throw new Error("Invalid remote-chrome value: empty. Expected host:port.");
  }
  const ipv6Match = target.match(/^\[(.+)]:(\d+)$/);
  let host: string | undefined;
  let portSegment: string | undefined;
  if (ipv6Match) {
    host = ipv6Match[1]?.trim();
    portSegment = ipv6Match[2]?.trim();
  } else {
    const lastColon = target.lastIndexOf(":");
    if (lastColon === -1) {
      throw new Error(
        `Invalid remote-chrome format: ${target}. Expected host:port (IPv6 must use [host]:port notation).`,
      );
    }
    host = target.slice(0, lastColon).trim();
    portSegment = target.slice(lastColon + 1).trim();
    if (host.includes(":")) {
      throw new Error(
        `Invalid remote-chrome format: ${target}. Wrap IPv6 addresses in brackets, e.g. --remote-chrome "[2001:db8::1]:9222".`,
      );
    }
  }
  if (!/^\d+$/.test(portSegment ?? "")) {
    throw new Error(`Invalid remote-chrome value: ${target}. Expected host:port.`);
  }
  const port = Number(portSegment);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid remote-chrome value: ${target}. Expected host:port.`);
  }
  return { host, port };
}

export function hasChatGptRemoteAffinityFlags(options: ChatGptRemoteAffinityCliOptions): boolean {
  return Boolean(
    options.remoteChromeBrowserId ||
    options.remoteChromeBrowserWs ||
    options.remoteChromeAccountDigest ||
    options.expectedEmail,
  );
}

export function resolveChatGptRemoteEmailAffinity(
  options: ChatGptRemoteAffinityCliOptions,
): ChatGptRemoteEmailAffinity {
  const remoteChrome = options.remoteChrome?.trim();
  const browserId = options.remoteChromeBrowserId?.trim();
  const browserWSEndpoint = options.remoteChromeBrowserWs?.trim();
  const expectedEmail = options.expectedEmail?.trim().toLowerCase();
  if (!remoteChrome || !browserId || !browserWSEndpoint || !expectedEmail) {
    throw new Error(
      `The account-bound inventory wrapper requires --remote-chrome, --remote-chrome-browser-id, --remote-chrome-browser-ws, and --expected-email together (${CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV}=1).`,
    );
  }
  const remoteTarget = parseRemoteChromeTarget(remoteChrome);
  const boundBrowser = bindRemoteChromeBrowserWebSocketEndpoint({
    browserWSEndpoint,
    ...remoteTarget,
  });
  if (boundBrowser.browserId !== browserId) {
    throw new Error("Remote Chrome browser id does not match its browser WebSocket URL.");
  }
  return {
    ...remoteTarget,
    browserId,
    browserWSEndpoint: boundBrowser.browserWSEndpoint,
    expectedEmail,
  };
}

export function resolveChatGptRemoteAccountAffinity(
  options: ChatGptRemoteAffinityCliOptions,
): ChatGptRemoteAccountAffinity {
  const affinity = resolveChatGptRemoteEmailAffinity(options);
  const accountDigest = options.remoteChromeAccountDigest?.trim();
  if (!accountDigest) {
    throw new Error(
      `The account-bound export wrapper also requires --remote-chrome-account-digest (${CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV}=1).`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(accountDigest)) {
    throw new Error("Remote Chrome account identity is invalid.");
  }
  return { ...affinity, accountDigest };
}
