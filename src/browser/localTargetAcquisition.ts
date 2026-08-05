import { connectWithNewTabWithExactAuthority } from "./chromeLifecycle.js";
import { connectToExistingChatGptTab } from "./liveTabs.js";
import { describeDevtoolsFirewallHint } from "./localExecutionContext.js";
import type { LocalBrowserAcquisition } from "./localAcquisition.js";
import type { LocalBrowserRunState } from "./localRunState.js";
import type { BrowserLogger } from "./types.js";

export interface LocalTargetAcquisitionContext {
  acquisition: LocalBrowserAcquisition;
  state: LocalBrowserRunState;
  logger: BrowserLogger;
  publishRuntime: () => Promise<void>;
}

export async function acquireExactLocalBrowserTarget({
  acquisition,
  state,
  logger,
  publishRuntime,
}: LocalTargetAcquisitionContext): Promise<void> {
  const {
    chrome,
    chromeHost,
    config,
    manualLogin,
    acquisitionTargetMarkerUrl,
    settlementEndpointAuthority,
  } = acquisition;
  try {
    if (!settlementEndpointAuthority) {
      throw new Error("Locally owned Chrome has no retained exact endpoint authority.");
    }
    if (config.browserTabRef) {
      const attached = await connectToExistingChatGptTab({
        host: chromeHost,
        port: chrome.port,
        ref: config.browserTabRef,
        endpointAuthority: settlementEndpointAuthority,
      });
      state.client = attached.client;
      state.isolatedTargetId = attached.targetId ?? null;
      state.lastTargetId = attached.targetId ?? undefined;
      state.lastUrl = attached.tab.url || state.lastUrl;
      state.ownsTarget = false;
      logger(
        `Attached to existing ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
      );
    } else {
      const devtoolsRetries = manualLogin ? 6 : 0;
      const connection = await connectWithNewTabWithExactAuthority(
        settlementEndpointAuthority,
        logger,
        acquisitionTargetMarkerUrl,
        {
          retries: devtoolsRetries,
          retryDelayMs: 500,
        },
      );
      state.client = connection.client;
      state.isolatedTargetId = connection.targetId ?? null;
      state.lastTargetId = connection.targetId ?? undefined;
      state.ownsTarget = Boolean(connection.targetId);
    }
    await publishRuntime();
    if (state.tabLease && state.isolatedTargetId) {
      await state.tabLease.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: state.isolatedTargetId,
      });
    }
  } catch (error) {
    const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
    if (hint) {
      logger(hint);
    }
    throw error;
  }
}
