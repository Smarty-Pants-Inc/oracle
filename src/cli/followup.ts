import type { BrowserSessionConfig, SessionMetadata } from "../sessionStore.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { buildConversationUrl } from "../browser/reattachHelpers.js";
import { resolveRecoveryUrl } from "../browser/recoverConversation.js";
import { isRecoverableChatGptConversationUrl } from "../browser/reattachability.js";
import { browserIdFromWebSocketEndpoint } from "../browser/profileState.js";
import { DEFAULT_MODEL } from "../oracle/config.js";
import type { ModelName } from "../oracle/types.js";

export interface BrowserFollowupResolution {
  sessionId: string;
  resumeConversationUrl: string;
  model: ModelName;
  browserConfig: BrowserSessionConfig;
}

export interface FollowupSessionReader {
  readSession(sessionId: string): Promise<SessionMetadata | null>;
}

/**
 * Resolve the ChatGPT conversation URL to reopen for a browser follow-up.
 *
 * Reuses the same recoverable-URL gate as conversation recovery
 * (`resolveRecoveryUrl`): prefer the post-harvest URL, fall back to the
 * runtime tab URL, and reject home / project-shell / external URLs via
 * `isRecoverableChatGptConversationUrl`. Only when neither candidate is a
 * recoverable `chatgpt.com/c/<id>` URL do we rebuild from a stored
 * `conversationId` against the session's ChatGPT base — and that rebuilt URL is
 * gated too. This prevents a stale or attacker-controlled URL in session
 * metadata from navigating the signed-in browser profile somewhere unintended.
 */
export function resolveBrowserResumeConversationUrl(
  metadata: SessionMetadata,
  fallbackBaseUrl = CHATGPT_URL,
): string | null {
  const gatedUrl = resolveRecoveryUrl(metadata);
  if (gatedUrl) {
    return gatedUrl;
  }
  const conversationId = metadata.browser?.runtime?.conversationId?.trim();
  if (!conversationId) {
    return null;
  }
  const baseUrl = metadata.browser?.config?.url ?? fallbackBaseUrl;
  const built = buildConversationUrl({ conversationId }, baseUrl);
  if (built && isRecoverableChatGptConversationUrl(built)) {
    return built;
  }
  return null;
}

export async function resolveBrowserFollowupReference(
  value: string,
  store: FollowupSessionReader,
): Promise<BrowserFollowupResolution | null> {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("resp_")) {
    return null;
  }

  const metadata = await store.readSession(trimmed);
  if (!metadata) {
    return null;
  }
  const mode = metadata.mode ?? metadata.options?.mode;
  const hasBrowserMetadata = Boolean(
    metadata.browser?.runtime || metadata.browser?.config || metadata.options?.browserConfig,
  );
  if (mode !== "browser" && !hasBrowserMetadata) {
    return null;
  }

  const resumeConversationUrl = resolveBrowserResumeConversationUrl(metadata);
  if (!resumeConversationUrl) {
    throw new Error(
      `Session ${trimmed} is a browser session but does not contain a ChatGPT conversation URL. Run "oracle status --hours 72 --limit 20" to list recent sessions.`,
    );
  }
  const parentBrowserConfig = metadata.options?.browserConfig ?? metadata.browser?.config;
  if (!parentBrowserConfig) {
    throw new Error(`Session ${trimmed} is missing its stored browser configuration.`);
  }
  const configuredBrowserId = parentBrowserConfig.remoteChromeBrowserId?.trim();
  const configuredBrowserWSEndpoint = parentBrowserConfig.remoteChromeBrowserWSEndpoint?.trim();
  const configuredAccountDigest = parentBrowserConfig.remoteChromeAccountDigest?.trim();
  const runtimeAccountDigest = metadata.browser?.runtime?.chatGptAccountDigest?.trim();
  if (
    configuredAccountDigest &&
    runtimeAccountDigest &&
    configuredAccountDigest !== runtimeAccountDigest
  ) {
    throw new Error(`Session ${trimmed} has conflicting stored account identity metadata.`);
  }
  const remoteChromeAccountDigest = runtimeAccountDigest ?? configuredAccountDigest;
  const runtimeBrowserWSEndpoint = metadata.browser?.runtime?.chromeBrowserWSEndpoint?.trim();
  let remoteChromeBrowserId = configuredBrowserId;
  let remoteChromeBrowserWSEndpoint = configuredBrowserWSEndpoint;
  if (configuredBrowserWSEndpoint) {
    const configuredWebSocketBrowserId = browserIdFromWebSocketEndpoint(
      configuredBrowserWSEndpoint,
    );
    if (configuredBrowserId && configuredWebSocketBrowserId !== configuredBrowserId) {
      throw new Error(`Session ${trimmed} has conflicting stored browser identity metadata.`);
    }
    remoteChromeBrowserId ??= configuredWebSocketBrowserId;
  }
  if (runtimeBrowserWSEndpoint) {
    const runtimeBrowserId = browserIdFromWebSocketEndpoint(runtimeBrowserWSEndpoint);
    if (remoteChromeBrowserId && runtimeBrowserId !== remoteChromeBrowserId) {
      throw new Error(`Session ${trimmed} has conflicting stored browser identity metadata.`);
    }
    remoteChromeBrowserId = runtimeBrowserId;
    remoteChromeBrowserWSEndpoint = runtimeBrowserWSEndpoint;
  }
  const hasRemoteAffinityMarker = Boolean(
    process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1" ||
    parentBrowserConfig.remoteChrome ||
    configuredBrowserId ||
    configuredBrowserWSEndpoint ||
    configuredAccountDigest ||
    runtimeAccountDigest,
  );
  const missingRemoteAffinity =
    hasRemoteAffinityMarker &&
    (!parentBrowserConfig.remoteChrome ||
      !remoteChromeBrowserId ||
      !remoteChromeBrowserWSEndpoint ||
      !remoteChromeAccountDigest);
  if (missingRemoteAffinity) {
    throw new Error(
      `Session ${trimmed} has no verified remote Chrome browser and account identity; start a fresh browser conversation through the agent wrapper.`,
    );
  }
  const storedModel = metadata.options?.model ?? metadata.model;
  const model =
    typeof storedModel === "string" && storedModel.startsWith("gpt-")
      ? (storedModel as ModelName)
      : DEFAULT_MODEL;
  return {
    sessionId: metadata.id,
    resumeConversationUrl,
    model,
    browserConfig: {
      ...parentBrowserConfig,
      ...(remoteChromeBrowserId && remoteChromeBrowserWSEndpoint && remoteChromeAccountDigest
        ? { remoteChromeBrowserId, remoteChromeBrowserWSEndpoint, remoteChromeAccountDigest }
        : {}),
      browserTabRef: null,
      resumeConversationUrl,
      researchMode: "off",
      archiveConversations: "never",
    },
  };
}
