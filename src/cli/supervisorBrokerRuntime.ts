import CDP from "chrome-remote-interface";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import {
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
} from "../browser/chromeLifecycle.js";
import { verifyDevToolsReachable } from "../browser/profileState.js";
import { pickTarget, type TargetInfoLite } from "../browser/reattachHelpers.js";
import type { BrowserLogger, ChromeClient } from "../browser/types.js";

const noopLogger: BrowserLogger = Object.assign((_: string) => {}, { verbose: false });

export interface SupervisorRuntimeContext {
  sessionId: string;
  runtime: BrowserRuntimeMetadata;
}

export interface SupervisorRuntimeConnection {
  client: ChromeClient;
  close: () => Promise<void>;
  host: string;
  port: number;
}

function parseSessionTimestamp(meta: SessionMetadata): number {
  const candidate = meta.startedAt ?? meta.completedAt ?? meta.createdAt;
  const parsed = Date.parse(candidate ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function runtimeReusePriority(meta: SessionMetadata): number {
  switch (meta.status) {
    case "running":
      return 2;
    case "completed":
      return 1;
    default:
      return 0;
  }
}

function supervisorRuntimePreference(meta: SessionMetadata): number {
  const config = meta.browser?.config;
  if (!config) {
    return 0;
  }
  return config.manualLogin === true && config.keepBrowser === true && config.attachRunning !== true
    ? 1
    : 0;
}

function hasReusableRuntime(meta: SessionMetadata): meta is SessionMetadata & {
  browser: { runtime: BrowserRuntimeMetadata };
} {
  const runtime = meta.browser?.runtime;
  return Boolean(runtime && (runtime.chromePort || runtime.chromeBrowserWSEndpoint));
}

function sortReusableRuntimeCandidates(
  metas: SessionMetadata[],
): (SessionMetadata & { browser: { runtime: BrowserRuntimeMetadata } })[] {
  return metas
    .filter(hasReusableRuntime)
    .sort(
      (left, right) =>
        supervisorRuntimePreference(right) - supervisorRuntimePreference(left) ||
        runtimeReusePriority(right) - runtimeReusePriority(left) ||
        parseSessionTimestamp(right) - parseSessionTimestamp(left),
    );
}

function pickReusableRuntimeCandidate(
  metas: SessionMetadata[],
): (SessionMetadata & { browser: { runtime: BrowserRuntimeMetadata } }) | undefined {
  return sortReusableRuntimeCandidates(metas)[0];
}

function resolvePort(runtime: BrowserRuntimeMetadata): number | null {
  if (runtime.chromePort && Number.isFinite(runtime.chromePort) && runtime.chromePort > 0) {
    return runtime.chromePort;
  }
  const endpoint = runtime.chromeBrowserWSEndpoint;
  if (!endpoint) {
    return null;
  }
  try {
    const parsed = new URL(endpoint);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function matchesRuntimeUrl(targetUrl: string | undefined, runtimeUrl: string | undefined): boolean {
  if (!targetUrl || !runtimeUrl) {
    return false;
  }
  return targetUrl.startsWith(runtimeUrl) || runtimeUrl.startsWith(targetUrl);
}

function extractConversationId(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1] ?? null;
}

function pickSupervisorRuntimeTarget(
  targets: TargetInfoLite[],
  runtime: BrowserRuntimeMetadata,
  strictTargetMatch: boolean,
): TargetInfoLite | undefined {
  if (strictTargetMatch) {
    if (runtime.chromeTargetId) {
      const byId = targets.find((target) => target.targetId === runtime.chromeTargetId);
      if (byId) {
        return byId;
      }
    }
    if (runtime.tabUrl) {
      const byUrl = targets.find((target) => matchesRuntimeUrl(target.url, runtime.tabUrl));
      if (byUrl) {
        return byUrl;
      }
    }
    if (runtime.conversationId) {
      const byConversation = targets.find(
        (target) => extractConversationId(target.url) === runtime.conversationId,
      );
      if (byConversation) {
        return byConversation;
      }
    }
    return undefined;
  }

  return pickTarget(targets, runtime);
}

async function pickReachableRuntimeCandidate(
  metas: SessionMetadata[],
  probe: typeof verifyDevToolsReachable = verifyDevToolsReachable,
): Promise<(SessionMetadata & { browser: { runtime: BrowserRuntimeMetadata } }) | undefined> {
  const candidates = sortReusableRuntimeCandidates(metas);
  for (const candidate of candidates) {
    const port = resolvePort(candidate.browser.runtime);
    if (!port) {
      continue;
    }
    const host = candidate.browser.runtime.chromeHost ?? "127.0.0.1";
    const reachable = await probe({ host, port, attempts: 1, timeoutMs: 1000 });
    if (reachable.ok) {
      return candidate;
    }
  }
  return undefined;
}

export async function resolveSupervisorRuntimeContext(
  followupSession?: string,
): Promise<SupervisorRuntimeContext> {
  const hinted = followupSession?.trim();
  if (hinted) {
    const meta = await sessionStore.readSession(hinted);
    if (!meta) {
      throw new Error(`Browser runtime session ${hinted} was not found.`);
    }
    if (!hasReusableRuntime(meta)) {
      throw new Error(`Session ${hinted} does not have reusable browser runtime metadata.`);
    }
    return {
      sessionId: meta.id,
      runtime: meta.browser.runtime,
    };
  }

  const metas = await sessionStore.listSessions();
  const latest = await pickReachableRuntimeCandidate(metas);
  if (!latest) {
    throw new Error(
      "No reachable browser runtime session was found. Run one Oracle browser turn first.",
    );
  }
  return {
    sessionId: latest.id,
    runtime: latest.browser.runtime,
  };
}

async function closeClient(client: ChromeClient | null | undefined): Promise<void> {
  if (!client || typeof client.close !== "function") {
    return;
  }
  await client.close().catch(() => undefined);
}

export async function connectSupervisorRuntime(
  runtime: BrowserRuntimeMetadata,
): Promise<SupervisorRuntimeConnection> {
  const host = runtime.chromeHost ?? "127.0.0.1";
  const port = resolvePort(runtime);
  if (!port) {
    throw new Error("Browser runtime metadata is missing a reachable DevTools port.");
  }
  const browserWSEndpoint = runtime.chromeBrowserWSEndpoint ?? undefined;

  const targets = (await listRemoteChromeTargets({
    host,
    port,
    browserWSEndpoint,
  })) as TargetInfoLite[];
  const strictTargetMatch = Boolean(browserWSEndpoint);
  const target = pickSupervisorRuntimeTarget(targets, runtime, strictTargetMatch);

  if (browserWSEndpoint && !target?.targetId) {
    throw new Error(
      "Unable to locate the existing Oracle browser tab for the reusable runtime. Run another Oracle browser turn or reopen the Oracle conversation before using supervisor thread controls.",
    );
  }

  const useBrowserSocketTarget = Boolean(browserWSEndpoint && target?.targetId);

  if (useBrowserSocketTarget) {
    const connection = await connectToRemoteChromeTarget(host, port, noopLogger, {
      browserWSEndpoint,
      targetId: target?.targetId,
      closeTargetOnDispose: false,
    });
    const { client } = connection;
    if (client.Runtime?.enable) {
      await client.Runtime.enable();
    }
    if (client.DOM?.enable) {
      await client.DOM.enable();
    }
    return {
      client,
      close: connection.close,
      host,
      port,
    };
  }

  const client = (await CDP({
    host,
    port,
    target: target?.targetId,
  })) as unknown as ChromeClient;
  if (client.Runtime?.enable) {
    await client.Runtime.enable();
  }
  if (client.DOM?.enable) {
    await client.DOM.enable();
  }
  return {
    client,
    close: async () => closeClient(client),
    host,
    port,
  };
}

export const __test__ = {
  pickSupervisorRuntimeTarget,
  pickReachableRuntimeCandidate,
  pickReusableRuntimeCandidate,
  sortReusableRuntimeCandidates,
  supervisorRuntimePreference,
};
